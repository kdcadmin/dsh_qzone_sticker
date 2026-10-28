import os from 'node:os'
import path from 'node:path'
import { discoverChromePort, readQzoneCookies } from './chrome.js'
import { loadSession } from './qqlogin.js'
import { buildRichval, uploadImage } from './upload.js'
import { postViaUi } from './uipost.js'
import { readRecentViaUi } from './silent.js'
import {
  buildPublishBody,
  parseQzoneBody,
  qzoneMessage,
  qzoneOk,
  redact,
  sessionFromCookies,
  summarizePosts,
  takePublishSlot,
  visibilityRight,
} from './session.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function pluginOptions(config = {}) {
  const uin = String(config.uin || process.env.QZONE_UIN || '2776757452').replace(/\D/g, '')
  const dailyLimit = Number(config.dailyLimit ?? 8)
  const minIntervalMs = Number(config.minIntervalMs ?? 60_000)
  const maxLength = Number(config.maxLength ?? 2000)
  return {
    uin,
    lockUin: config.lockUin === true,
    chromePort: Number(config.chromePort || 0),
    dailyLimit: Number.isInteger(dailyLimit) && dailyLimit > 0 ? dailyLimit : 8,
    minIntervalMs: Number.isInteger(minIntervalMs) && minIntervalMs >= 1000 ? minIntervalMs : 60_000,
    maxLength: Number.isInteger(maxLength) && maxLength > 0 ? Math.min(maxLength, 10000) : 2000,
    logFile: config.logFile || path.join(os.homedir(), '.dsh', 'qzone-publish-log.json'),
    imageDir: config.imageDir || process.env.QZONE_IMAGE_DIR || 'D:\\deepseek-harness\\生成表情包',
  }
}

async function login(options, signal) {
  // 优先用扫码登录存下来的会话（%USERPROFILE%\.dsh\qzone-session.json），没有或失效再退回 Chrome
  try {
    const saved = await loadSession()
    if (saved) {
      // 默认信任会话里的账号（扫码登的是谁就发谁的）；只有 lockUin 打开才强制必须是配置的 uin
      const fromSession = sessionFromCookies(saved.cookies, options.lockUin ? options.uin : '')
      if (fromSession.ok) return fromSession
    }
  } catch {
    // 会话文件读出问题就走 Chrome
  }
  const port = await discoverChromePort(options.chromePort)
  const cookies = await readQzoneCookies(port, signal)
  return sessionFromCookies(cookies, options.uin)
}

async function qzoneRequest(session, url, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        Cookie: session.cookieHeader,
        Referer: `https://user.qzone.qq.com/${session.uin}`,
        Origin: 'https://user.qzone.qq.com',
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      },
      ...(body ? { body } : {}),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('已取消')
    throw new Error('连接 QQ空间失败')
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error('QQ空间要求重新登录')
  }
  const text = await response.text()
  return parseQzoneBody(text.slice(0, 200_000))
}

export async function readStatus(options, signal) {
  try {
    const session = await login(options, signal)
    if (!session.ok) return { ok: false, uin: session.uin || '', message: session.message }
    // 本地会话文件可能是过期的（p_skey 是会话级 cookie，一般 1~2 小时就废）
    // ⇒ 真去访问一次空间首页：被 302 到登录页就是过期了
    try {
      const res = await fetch(`https://user.qzone.qq.com/${session.uin}`, {
        headers: { 'User-Agent': USER_AGENT, Cookie: session.cookieHeader },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      })
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, uin: session.uin, message: '登录态已过期（p_skey 失效），请重新点「生成登录二维码」扫一下' }
      }
      return { ok: true, uin: session.uin, message: session.message }
    } catch {
      // 联网校验失败（断网/超时）时不误判，按本地会话算
      return { ok: true, uin: session.uin, message: session.message + '（联网校验没通，按本地会话算）' }
    }
  } catch (error) {
    return { ok: false, uin: '', message: redact(error?.message || error) }
  }
}

export async function readRecent(options, limit, signal) {
  const count = Math.min(10, Math.max(1, Number(limit) || 5))
  try {
    const session = await login(options, signal)
    if (!session.ok) {
      return { ok: false, uin: session.uin || '', message: session.message, posts: [] }
    }
    const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6')
    url.searchParams.set('uin', session.uin)
    url.searchParams.set('hostuin', session.uin)
    url.searchParams.set('ftype', '0')
    url.searchParams.set('sort', '0')
    url.searchParams.set('pos', '0')
    url.searchParams.set('num', String(count))
    url.searchParams.set('replynum', '0')
    url.searchParams.set('g_tk', session.gtk)
    url.searchParams.set('code_version', '1')
    url.searchParams.set('format', 'json')
    const data = await qzoneRequest(session, url, { signal })
    if (!qzoneOk(data)) {
      const why = qzoneMessage(data)
      // 接口被限（常见「使用人数过多」）⇒ 改从空间主页抓，别让页面空着
      try {
        const ui = await readRecentViaUi(session.uin, count)
        if (ui.ok) return { ok: true, uin: session.uin, message: ui.message, posts: ui.posts }
      } catch {
        // 网页兜底也失败就按接口错误报
      }
      return { ok: false, uin: session.uin, message: why + '（若提示未登录，说明登录态过期了，重新扫码即可）', posts: [] }
    }
    const posts = summarizePosts(data, count)
    return {
      ok: true,
      uin: session.uin,
      message: posts.length ? `读到最近 ${posts.length} 条说说` : '最近没有说说',
      posts,
    }
  } catch (error) {
    return { ok: false, uin: '', message: redact(error?.message || error), posts: [] }
  }
}

export async function publishMood(options, args, signal) {
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  const visibility = args.visibility || 'public'
  const dryRun = args.dryRun === true
  const blank = {
    ok: false,
    uin: options.uin,
    tid: '',
    dryRun,
    message: '',
  }
  if (!content) return { ...blank, message: '说说内容是空的' }
  if (content.length > options.maxLength) {
    return { ...blank, message: `说说超过 ${options.maxLength} 字` }
  }
  if (!visibilityRight(visibility)) {
    return { ...blank, message: 'visibility 只能是 public、friends 或 private' }
  }
  try {
    const session = await login(options, signal)
    if (!session.ok) return { ...blank, uin: session.uin || options.uin, message: session.message }
    if (dryRun) {
      return {
        ok: true,
        uin: session.uin,
        tid: '',
        dryRun: true,
        message: `${session.message}。这是检查，没有发表。`,
      }
    }
    const slot = await takePublishSlot(options.logFile, options)
    if (!slot.ok) return { ...blank, uin: session.uin, message: slot.message }
    const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6')
    url.searchParams.set('g_tk', session.gtk)
    url.searchParams.set('uin', session.uin)
    // 带图说说：先试空间相册接口上传；被拒（如「相册不存在」）就改走网页 UI 发
    let richval = ''
    const wanted = Array.isArray(args.images) ? args.images.slice(0, 9) : []
    if (wanted.length) {
      try {
        const pics = []
        for (const file of wanted) pics.push(await uploadImage(session, file, signal))
        richval = buildRichval(pics)
      } catch (apiError) {
        try {
          const ui = await postViaUi(session.uin, content, wanted)
          return { ok: true, uin: session.uin, tid: '', dryRun: false, message: ui.message }
        } catch (uiError) {
          return {
            ...blank,
            uin: session.uin,
            message: '带图发表失败（接口：' + redact(apiError?.message || apiError) + '；网页：' + redact(uiError?.message || uiError) + '）',
          }
        }
      }
    }
    const data = await qzoneRequest(session, url, {
      method: 'POST',
      body: buildPublishBody({ uin: session.uin, content, visibility, richval }),
      signal,
    })
    if (!qzoneOk(data)) return { ...blank, uin: session.uin, dryRun: false, message: qzoneMessage(data) }
    const tid = String(data.tid || '')
    return {
      ok: true,
      uin: session.uin,
      tid,
      dryRun: false,
      message: tid ? `已发表到 QQ ${session.uin} 的空间，tid=${tid}` : `已发表到 QQ ${session.uin} 的空间`,
    }
  } catch (error) {
    return { ...blank, message: redact(error?.message || error) }
  }
}
