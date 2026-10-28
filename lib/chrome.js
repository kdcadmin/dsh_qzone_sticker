import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const COOKIE_URLS = [
  'https://user.qzone.qq.com/',
  'https://qzone.qq.com/',
]

function chromePortFiles() {
  const files = []
  if (process.env.LOCALAPPDATA) {
    files.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'))
  }
  if (process.platform === 'darwin') {
    files.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'))
  }
  if (process.platform === 'linux') {
    files.push(path.join(os.homedir(), '.config', 'google-chrome', 'DevToolsActivePort'))
  }
  return files
}

export async function discoverChromePort(explicit) {
  const chosen = Number(explicit || process.env.QZONE_CHROME_PORT || 0)
  if (Number.isInteger(chosen) && chosen > 0 && chosen <= 65535) return chosen
  for (const file of chromePortFiles()) {
    try {
      const port = Number((await readFile(file, 'utf8')).split(/\r?\n/, 1)[0])
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    } catch {
      // 这个候选路径不存在时继续找下一个。
    }
  }
  throw new Error('没有找到 Chrome 远程调试端口。请打开 chrome://inspect/#remote-debugging，勾选 Allow remote debugging，然后重启 Chrome。也可以设置环境变量 QZONE_CHROME_PORT。')
}

function assertLocalWs(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Chrome 调试地址无效')
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    throw new Error('只允许连接本机 Chrome')
  }
}

async function getJson(url, signal) {
  let response
  try {
    response = await fetch(url, { signal })
  } catch {
    throw new Error('连不上本机 Chrome。请确认已允许远程调试，并且 Chrome 正在运行。')
  }
  if (!response.ok) {
    throw new Error('Chrome 调试端口没有响应。请在 chrome://inspect/#remote-debugging 允许远程调试。')
  }
  return response.json()
}

function openSocket(url, signal) {
  assertLocalWs(url)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const ws = new WebSocket(url)
    const fail = (error) => {
      ws.close()
      reject(error)
    }
    const onOpen = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      ws._pending = new Map()
      ws._seq = 0
      ws.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!message.id || !ws._pending.has(message.id)) return
        const slot = ws._pending.get(message.id)
        ws._pending.delete(message.id)
        clearTimeout(slot.timer)
        if (message.error) slot.reject(new Error(message.error.message || 'Chrome 调用失败'))
        else slot.resolve(message.result || {})
      })
      resolve(ws)
    }
    const onError = () => fail(new Error('无法连接本机 Chrome 调试端口'))
    const onAbort = () => fail(new Error('已取消'))
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function rpc(ws, method, params, signal, sessionId) {
  const id = ++ws._seq
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      ws._pending.delete(id)
      reject(new Error('Chrome 响应超时'))
    }, 8000)
    const onAbort = () => {
      clearTimeout(timer)
      ws._pending.delete(id)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (settle, value) => {
      signal?.removeEventListener('abort', onAbort)
      settle(value)
    }
    ws._pending.set(id, {
      timer,
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    })
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    ws.send(JSON.stringify(payload))
  })
}

async function readCookiesFromSocket(ws, signal) {
  try {
    const direct = await rpc(ws, 'Network.getCookies', { urls: COOKIE_URLS }, signal)
    if (direct.cookies?.length) return direct.cookies
  } catch {
    // 浏览器级连接不支持时，改从已有页面读取。
  }
  try {
    const all = await rpc(ws, 'Storage.getCookies', {}, signal)
    const list = Array.isArray(all.cookies) ? all.cookies : []
    const hit = list.filter((cookie) => String(cookie?.domain || '').includes('qq.com'))
    if (hit.length) return hit
  } catch {
    // 浏览器级 Storage.getCookies 不可用时继续走页面附加。
  }
  const version = new URL(ws.url)
  const pages = await getJson(`${version.protocol === 'wss:' ? 'https:' : 'http:'}//${version.host}/json/list`, signal)
  const page = Array.isArray(pages) ? pages.find((item) => item.type === 'page' && (item.targetId || item.id)) : null
  if (!page) {
    throw new Error('Chrome 里没有打开的网页。请先打开任意页面，并登录 QQ 空间。')
  }
  const attached = await rpc(ws, 'Target.attachToTarget', { targetId: page.targetId || page.id, flatten: true }, signal)
  try {
    const result = await rpc(ws, 'Network.getCookies', { urls: COOKIE_URLS }, signal, attached.sessionId)
    return result.cookies || []
  } finally {
    if (attached.sessionId) {
      await rpc(ws, 'Target.detachFromTarget', { sessionId: attached.sessionId }, signal).catch(() => {})
    }
  }
}

async function debuggerWsUrl(port, signal) {
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`, signal)
    if (version?.webSocketDebuggerUrl) return version.webSocketDebuggerUrl
  } catch {
    // 新版 Chrome 用 chrome://inspect 打开远程调试时，HTTP /json/* 返回 404，改读 DevToolsActivePort。
  }
  for (const file of chromePortFiles()) {
    try {
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      const found = Number(lines[0])
      const wsPath = (lines[1] || '').trim()
      if (found === Number(port) && wsPath) return `ws://127.0.0.1:${port}${wsPath}`
    } catch {
      // 这个候选路径不存在时继续找下一个。
    }
  }
  throw new Error('Chrome 没有提供调试地址')
}

export async function readQzoneCookies(port, signal) {
  const wsUrl = await debuggerWsUrl(port, signal)
  const ws = await openSocket(wsUrl, signal)
  try {
    return await readCookiesFromSocket(ws, signal)
  } finally {
    ws.close()
  }
}
