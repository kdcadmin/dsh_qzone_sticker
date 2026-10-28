// 静默 Chrome（跟抖音同款）：专属 profile + headless + CDP，用真实浏览器完成 QQ 扫码登录
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { saveSession } from './qqlogin.js'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'qzone-chrome')
const PORT = Number(process.env.QZONE_CHROME_PORT || 9335)
const LOGIN_URL = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?daid=5&appid=549000912&style=20&hide_title_bar=1&low_login=1&qlogin_auto_login=1&no_verifyimg=1&link_target=blank&target=self&s_url=https%3A%2F%2Fqzs.qq.com%2Fqzone%2Fv5%2Fjump.html&pt_3rd_aid=0'

let proc = null
let ws = null
let seq = 0
const pending = new Map()
let pageSession = null
let browserVersion = null

function findChrome() {
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) || ''
}

async function portOpen() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) {
      browserVersion = await r.json()
      return true
    }
  } catch {
    // 没起来
  }
  return false
}

async function ensureBrowser() {
  if (ws && browserVersion) return
  if (!(await portOpen())) {
    const exe = findChrome()
    if (!exe) throw new Error('没找到 chrome.exe')
    await mkdir(PROFILE_DIR, { recursive: true })
    proc = spawn(exe, [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=1280,900',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const end = Date.now() + 25000
    while (Date.now() < end) {
      if (await portOpen()) break
      await new Promise((r) => setTimeout(r, 350))
    }
    if (!browserVersion) throw new Error('静默 Chrome 没起来（端口 ' + PORT + '）')
  }
  const wsUrl = browserVersion.webSocketDebuggerUrl
  if (!wsUrl) throw new Error('Chrome 没给调试地址')
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('连不上静默 Chrome')), { once: true })
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error.message || 'CDP 出错'))
    else slot.resolve(msg.result || {})
  })
}

function call(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    ws.send(JSON.stringify(payload))
  })
}

async function openLoginPage() {
  await ensureBrowser()
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const attached = await call('Target.attachToTarget', { targetId, flatten: true })
  pageSession = attached.sessionId
  await call('Page.enable', {}, pageSession)
  await call('Page.navigate', { url: LOGIN_URL }, pageSession)
  // 等二维码 <img> 出现
  const end = Date.now() + 30000
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const r = await call('Runtime.evaluate', {
        expression: `(() => { const imgs=[...document.querySelectorAll('img')]; const img=imgs.find(i=>i.src&&/ptqrshow|qrcode/i.test(i.src)); if(!img) return null; const b=img.getBoundingClientRect(); if(b.width<40) return null; return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`,
        returnByValue: true,
      }, pageSession)
      const rect = r?.result?.value
      if (rect) return rect
    } catch {
      // 页面还没好
    }
  }
  // 兜底：整个页面截图（让上层看到实际情况）
  const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession)
  return { fallback: true, dataUrl: 'data:image/png;base64,' + shot.data }
}

export async function startQrLoginSilent() {
  const rect = await openLoginPage()
  if (rect.fallback) return { ok: true, dataUrl: rect.dataUrl, mode: 'page' }
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - 12), y: Math.max(0, rect.y - 12), width: rect.w + 24, height: rect.h + 24, scale: 2 },
  }, pageSession)
  return { ok: true, dataUrl: 'data:image/png;base64,' + shot.data, mode: 'qr', rect }
}

async function cookiesNow() {
  const r = await call('Storage.getCookies', {})
  return (r.cookies || []).filter((c) => String(c.domain || '').includes('qq.com'))
}

export async function pollQrLoginSilent() {
  if (!ws || !pageSession) return { state: 'expired', message: '没有进行中的二维码，请重新生成' }
  const cookies = await cookiesNow()
  const pSkey = cookies.find((c) => c.name === 'p_skey')
  const uin = String(cookies.find((c) => c.name === 'p_uin')?.value || cookies.find((c) => c.name === 'uin')?.value || '').replace(/\D/g, '')
  if (pSkey) {
    await saveSession(cookies, uin)
    return { state: 'confirmed', uin, cookies, message: '扫码登录成功，登录态已保存' }
  }
  // 页面状态兜底
  let text = ''
  try {
    const r = await call('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.slice(0,300) : ""', returnByValue: true }, pageSession)
    text = String(r?.result?.value || '')
  } catch {
    // 忽略
  }
  if (/扫码成功|已扫描|已扫码|请在手机上确认/.test(text)) return { state: 'scanned', message: '已扫码，请在手机上确认' }
  if (/二维码.*失效|已失效|请点击刷新/.test(text)) return { state: 'expired', message: '二维码过期了，请重新生成' }
  return { state: 'waiting', message: '等待扫码' }
}

/** 用静默 Chrome 访问一次空间主页，把 cookie（p_skey 等）刷新后落盘，做会话保活 */
export async function refreshSessionViaSilent(uinHint = '') {
  await ensureBrowser()
  const target = await call('Target.createTarget', { url: `https://user.qzone.qq.com/${uinHint || ''}` })
  const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const S = attached.sessionId
  try {
    await call('Page.enable', {}, S)
    await new Promise((r) => setTimeout(r, 4500))
    const r = await call('Storage.getCookies', {})
    const cookies = (r.cookies || []).filter((c) => String(c.domain || '').includes('qq.com'))
    const pSkey = cookies.find((c) => c.name === 'p_skey')
    if (!pSkey) return { ok: false, message: '静默 Chrome 里没有登录态了，需要重新扫码' }
    const uin = String(cookies.find((c) => c.name === 'p_uin')?.value || cookies.find((c) => c.name === 'uin')?.value || '').replace(/\D/g, '')
    await saveSession(cookies, uin || uinHint)
    return { ok: true, uin: uin || uinHint, message: '会话已刷新' }
  } finally {
    try { await call('Target.closeTarget', { targetId: target.targetId }) } catch {}
  }
}

/** 从空间主页动态列表里抓最近几条说说（接口被限时用它兜底） */
export async function readRecentViaUi(uin, limit = 5) {
  await ensureBrowser()
  const target = await call('Target.createTarget', { url: `https://user.qzone.qq.com/${uin}` })
  const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const S = attached.sessionId
  try {
    await call('Page.enable', {}, S)
    await new Promise((r) => setTimeout(r, 8000))
    const r = await call('Runtime.evaluate', {
      expression: `(() => {
        const list = document.querySelector('#feed_friend_list');
        if (!list) return null;
        const out = [];
        for (const el of list.querySelectorAll('div.f-item, li.f-item')) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          if (/广告|立即下载|立即体验|热门游戏/.test(t)) continue;
          out.push(t.slice(0, 300));
        }
        return out.slice(0, ${Number(limit) || 5});
      })()`,
      returnByValue: true,
    }, S)
    const posts = Array.isArray(r?.result?.value) ? r.result.value : []
    if (!posts.length) return { ok: false, message: '网页里没抓到说说（可能页面没加载出来）', posts: [] }
    return {
      ok: true,
      message: '已从空间主页读到最近 ' + posts.length + ' 条（接口被限，走网页读取）',
      posts: posts.map((content, i) => ({ tid: 'ui-' + i, content, createdAt: '' })),
    }
  } finally {
    try { await call('Target.closeTarget', { targetId: target.targetId }) } catch {}
  }
}

export async function closeSilentBrowser() {
  try {
    if (ws) ws.close()
  } catch {
    // 忽略
  }
  ws = null
  pageSession = null
  browserVersion = null
  try {
    if (proc && !proc.killed) proc.kill()
  } catch {
    // 忽略
  }
  proc = null
}

/** 退出登录：关掉静默 Chrome 并删掉它的 profile（下次要重新扫码） */
export async function resetSilentProfile() {
  await closeSilentBrowser()
  try {
    await rm(PROFILE_DIR, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
