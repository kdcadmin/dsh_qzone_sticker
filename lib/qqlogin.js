// QQ空间网页扫码登录（QQ 官方 ptlogin 流程），不依赖 Chrome。
// 流程：ptqrshow 拿二维码 + qrsig → ptqrlogin 轮询 → 成功后跟跳转拿 p_skey → 落盘会话。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const APPID = '549000912'
const SESSION_FILE = path.join(os.homedir(), '.dsh', 'qzone-session.json')

export function sessionPath() {
  return SESSION_FILE
}

export function hash33(str) {
  let h = 0
  for (let i = 0; i < str.length; i += 1) h = (h << 5) + h + str.charCodeAt(i)
  return String(h & 0x7fffffff)
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function domainMatch(cookieDomain, host) {
  const d = String(cookieDomain || '').replace(/^\./, '')
  if (!d) return false
  return host === d || host.endsWith('.' + d)
}

function mergeSetCookies(jar, setCookies, requestHost) {
  for (const raw of setCookies) {
    const parts = String(raw).split(';')
    const pair = parts.shift() || ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: requestHost, path: '/', expires: 0 }
    for (const attr of parts) {
      const [k, v = ''] = attr.split('=')
      const key = String(k || '').trim().toLowerCase()
      const val = String(v || '').trim()
      if (key === 'domain' && val) cookie.domain = val
      else if (key === 'path' && val) cookie.path = val
      else if (key === 'max-age' && val) cookie.expires = Date.now() + Number(val) * 1000
      else if (key === 'expires' && val) {
        const t = Date.parse(val)
        if (Number.isFinite(t)) cookie.expires = t
      }
    }
    const idx = jar.findIndex((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path)
    if (idx >= 0) jar.splice(idx, 1, cookie)
    else jar.push(cookie)
  }
}

function headerFor(jar, url) {
  const host = hostOf(url)
  return jar
    .filter((c) => domainMatch(c.domain, host) && (!c.expires || c.expires > Date.now()))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

async function httpGet(url, jar, { referer = 'https://xui.ptlogin2.qq.com/' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Cookie: headerFor(jar, url) },
    redirect: 'manual',
  })
  mergeSetCookies(jar, res.headers.getSetCookie?.() || [], hostOf(url))
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    buf,
    text: () => buf.toString('utf8'),
  }
}

export async function startQrLogin() {
  const jar = []
  const u1 = encodeURIComponent('https://qzs.qq.com/qzone/v5/jump.html')
  // 第一步：xlogin 拿 pt_login_sig 等 cookie（少了 login_sig 会报「提交参数错误」code=7）
  await httpGet(
    `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?daid=5&appid=${APPID}&style=20&hide_title_bar=1&low_login=1&qlogin_auto_login=1&no_verifyimg=1&link_target=blank&target=self&s_url=${u1}&pt_3rd_aid=0`,
    jar,
    { referer: 'https://qzone.qq.com/' },
  )
  const res = await httpGet(
    `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${APPID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=5&pt_3rd_aid=0`,
    jar,
    { referer: 'https://xui.ptlogin2.qq.com/' },
  )
  const qrsig = jar.find((c) => c.name === 'qrsig')
  const loginSig = jar.find((c) => c.name === 'pt_login_sig')
  if (!qrsig || res.buf.length < 200) throw new Error('QQ 没有返回二维码，请稍后重试')
  return {
    jar,
    qrsig: qrsig.value,
    loginSig: loginSig?.value || '',
    ptqrtoken: hash33(qrsig.value),
    dataUrl: 'data:image/png;base64,' + res.buf.toString('base64'),
    startedAt: Date.now(),
  }
}

function parsePtui(text) {
  const m = String(text || '').match(/ptuiCB\(([\s\S]*?)\)/)
  if (!m) return null
  const args = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  return { code: args[0], msg: args[4] || '', args }
}

export async function pollQrLogin(state) {
  const u1 = encodeURIComponent('https://qzs.qq.com/qzone/v5/jump.html')
  const loginSig = encodeURIComponent(state.loginSig || '')
  const url = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${u1}&ptqrtoken=${state.ptqrtoken}&ptredirect=1&h=1&t=1&g=1&from_u1=1&s_url=${u1}&ptlang=2052&js_type=1&js_ver=10270&login_sig=${loginSig}&aid=${APPID}&daid=5&pt_uistyle=40`
  const res = await httpGet(url, state.jar, { referer: 'https://xui.ptlogin2.qq.com/' })
  const ptui = parsePtui(res.text())
  if (!ptui) return { state: 'unknown', message: 'QQ 返回格式不懂：' + res.text().slice(0, 80) }
  if (ptui.code === '66') return { state: 'waiting', message: '等待扫码' }
  if (ptui.code === '67') return { state: 'scanned', message: '已扫码，请在手机上点确认' }
  if (ptui.code === '65') return { state: 'expired', message: '二维码已过期，请重新生成' }
  if (ptui.code !== '0') return { state: 'unknown', code: ptui.code, message: ptui.msg || 'code=' + ptui.code }

  const jump = (ptui.args || []).find((a) => /^https?:\/\//.test(a)) || ''
  if (!jump) return { state: 'confirmed', message: '登录成功，但没拿到跳转地址' }
  const jar = state.jar
  let cur = jump
  for (let i = 0; i < 6 && cur; i += 1) {
    const r = await httpGet(cur, jar, { referer: 'https://user.qzone.qq.com/' })
    if (!r.location) break
    cur = /^https?:\/\//.test(r.location) ? r.location : new URL(r.location, cur).toString()
  }
  const uin = String(jar.find((c) => c.name === 'p_uin')?.value || jar.find((c) => c.name === 'uin')?.value || '').replace(/\D/g, '')
  if (uin) {
    try {
      await httpGet(`https://user.qzone.qq.com/${uin}`, jar, { referer: 'https://user.qzone.qq.com/' })
    } catch {
      // 拿 p_skey 失败时下面会报
    }
  }
  if (!jar.find((c) => c.name === 'p_skey')) {
    return { state: 'confirmed', message: '登录成功，但没有 p_skey——请用这个 QQ 在 Chrome 里打开一次空间', uin }
  }
  return { state: 'confirmed', message: '登录成功', uin, cookies: jar }
}

export async function saveSession(cookies, uin) {
  await mkdir(path.dirname(SESSION_FILE), { recursive: true })
  const clean = (Array.isArray(cookies) ? cookies : []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires || 0,
  }))
  await writeFile(SESSION_FILE, JSON.stringify({ uin: String(uin || ''), savedAt: new Date().toISOString(), cookies: clean }))
  return SESSION_FILE
}

export async function loadSession() {
  try {
    const raw = JSON.parse(await readFile(SESSION_FILE, 'utf8'))
    if (raw && Array.isArray(raw.cookies) && raw.cookies.length) return raw
  } catch {
    // 没有会话文件
  }
  return null
}

export async function clearSession() {
  try {
    await writeFile(SESSION_FILE, JSON.stringify({ uin: '', savedAt: new Date().toISOString(), cookies: [] }))
  } catch {
    // 忽略
  }
}
