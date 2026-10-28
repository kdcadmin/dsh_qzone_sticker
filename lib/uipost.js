// 网页 UI 带图发说说：在专属 Chrome 里打开空间主页，真实操作「写文字 → 传图 → 点发表」
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'qzone-chrome')
const PORT = Number(process.env.QZONE_UI_PORT || 9347)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) || ''
}

async function portUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) return await r.json()
  } catch {
    // 没起来
  }
  return null
}

async function ensureChrome() {
  let version = await portUp()
  let spawned = null
  if (!version) {
    const exe = findChrome()
    if (!exe) throw new Error('没找到 chrome.exe')
    await mkdir(PROFILE_DIR, { recursive: true })
    spawned = spawn(exe, [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=1400,1000',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 60; i += 1) {
      version = await portUp()
      if (version) break
      await sleep(400)
    }
    if (!version) throw new Error('静默 Chrome 没起来（端口 ' + PORT + '）')
  }
  return { version, spawned }
}

async function openSession(version) {
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const pending = new Map()
  const events = []
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.method) { events.push(m); return }
    const s = pending.get(m.id)
    if (!s) return
    pending.delete(m.id)
    m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result)
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('连不上静默 Chrome')), { once: true })
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    const p = { id, method, params }
    if (sessionId) p.sessionId = sessionId
    ws.send(JSON.stringify(p))
  })
  const evalJs = async (expression, S) => (await call('Runtime.evaluate', { expression, returnByValue: true }, S))?.result?.value
  const mouse = async (x, y, S) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, S)
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, S)
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, S)
  }
  return { ws, call, evalJs, mouse, events }
}

/** 用网页 UI 发一条带图说说；失败抛错 */
export async function postViaUi(uin, content, images) {
  const files = (Array.isArray(images) ? images : []).slice(0, 9).filter((f) => f && existsSync(f))
  if (!files.length) throw new Error('没有可用的图片文件')
  const { version, spawned } = await ensureChrome()
  const s = await openSession(version)
  let sessionId = null
  try {
    const target = await s.call('Target.createTarget', { url: 'about:blank' })
    const attached = await s.call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    sessionId = attached.sessionId
    const T = sessionId
    await s.call('Page.enable', {}, T)
    await s.call('DOM.enable', {}, T)
    await s.call('Page.setInterceptFileChooserDialog', { enabled: true }, T)
    await s.call('Page.navigate', { url: `https://user.qzone.qq.com/${uin}` }, T)
    await sleep(8000)

    const sel = '.qz-poster-bd [contenteditable="true"][id$="substitutor_content"]'
    let edRect = null
    for (let i = 0; i < 20; i += 1) {
      edRect = await s.evalJs(`(() => { const ed = document.querySelector('${sel}'); if (!ed) return null; const r = ed.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, T)
      if (edRect) break
      await sleep(800)
    }
    if (!edRect) throw new Error('网页里找不到发说说输入框（可能登录态失效，需要重新扫码）')

    await s.mouse(edRect.x, edRect.y, T)
    await sleep(500)
    await s.call('Input.insertText', { text: content }, T)
    await sleep(600)

    const picRect = await s.evalJs(`(() => { const a = document.querySelector('.qz-poster-bd .item-pic a.pic'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, T)
    if (!picRect) throw new Error('找不到「照片」按钮')
    await s.mouse(picRect.x, picRect.y, T)
    await sleep(1200)

    const localRect = await s.evalJs(`(() => { const li = document.querySelector('li.qz_poster_btn_local_pic'); if (!li) return null; const r = li.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width) }; })()`, T)
    if (!localRect || !localRect.w) throw new Error('找不到「本地」按钮')
    await s.mouse(localRect.x, localRect.y, T)
    await sleep(1500)

    let backendNodeId = null
    for (const e of s.events) {
      if (e.method === 'Page.fileChooserOpened' && e.params?.backendNodeId) backendNodeId = e.params.backendNodeId
    }
    if (!backendNodeId) {
      const doc = await s.call('DOM.getDocument', { depth: -1 }, T)
      const q = await s.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, T)
      if (q?.nodeId) {
        const d = await s.call('DOM.describeNode', { nodeId: q.nodeId }, T)
        backendNodeId = d?.node?.backendNodeId || null
      }
    }
    if (!backendNodeId) throw new Error('没能把图片塞进上传框')
    await s.call('DOM.setFileInputFiles', { files, backendNodeId }, T)
    await sleep(7000)

    const pub = await s.evalJs(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('a,button,span,div,input')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        const val = (el.value || '').trim();
        if (!/^(发表|发布)$/.test(own) && !/^(发表|发布)$/.test(val)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      return out.slice(0, 4);
    })()`, T)
    if (!Array.isArray(pub) || !pub.length) throw new Error('找不到「发表」按钮')
    await s.mouse(pub[0].x, pub[0].y, T)
    await sleep(6000)

    const cleared = await s.evalJs(`(() => { const ed = document.querySelector('${sel}'); return !ed || /说点儿什么吧/.test(ed.innerText || ''); })()`, T)
    if (!cleared) throw new Error('点了发表但输入框没清空，可能没发成功')
    try {
      const shot = await s.call('Page.captureScreenshot', { format: 'png' }, T)
      await writeFile(path.join(os.homedir(), '.dsh', 'qzone-last-post.png'), Buffer.from(shot.data, 'base64'))
    } catch {
      // 截图失败不影响结果
    }
    return { ok: true, message: `已用网页 UI 发到 QQ ${uin} 的空间（带图 ${files.length} 张）` }
  } finally {
    try { s.ws.close() } catch {}
    if (spawned) {
      await sleep(500)
      try { spawned.kill() } catch {}
    }
  }
}
