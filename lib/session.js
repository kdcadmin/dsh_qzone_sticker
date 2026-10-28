import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RIGHTS = {
  public: '1',
  friends: '4',
  private: '64',
}

export function gtk(key) {
  let hash = 5381
  for (let i = 0; i < key.length; i += 1) {
    hash += (hash << 5) + key.charCodeAt(i)
  }
  return String(hash & 0x7fffffff)
}

export function normalizeUin(value) {
  return String(value || '').replace(/\D/g, '')
}

export function visibilityRight(visibility) {
  return RIGHTS[visibility] || ''
}

export function redact(value) {
  return String(value ?? '')
    .replace(/p_skey=[^;\s]+/gi, 'p_skey=***')
    .replace(/(^|;\s*)skey=[^;\s]+/gi, '$1skey=***')
    .replace(/p_uin=[^;\s]+/gi, 'p_uin=***')
    .replace(/uin=o?\d+/gi, 'uin=***')
    .slice(0, 240)
}

function pick(cookies, name) {
  const rows = cookies.filter((cookie) => cookie?.name === name && cookie.value)
  return rows.find((cookie) => String(cookie.domain || '').includes('qzone.qq.com'))
    || rows.find((cookie) => String(cookie.domain || '').includes('qq.com'))
    || rows[0]
}

export function sessionFromCookies(cookies, expectedUin) {
  const list = Array.isArray(cookies) ? cookies : []
  const pSkey = pick(list, 'p_skey')?.value || ''
  const uin = normalizeUin(pick(list, 'p_uin')?.value || pick(list, 'uin')?.value || '')
  if (!pSkey || !uin) {
    return {
      ok: false,
      uin,
      message: 'Chrome 里没有 QQ 空间登录态。请用这个 Chrome 打开空间并登录。',
    }
  }
  const expected = normalizeUin(expectedUin)
  if (expected && uin !== expected) {
    return {
      ok: false,
      uin,
      message: `当前登录 QQ 是 ${uin}，插件只允许发给 ${expected}。`,
    }
  }
  const cookieHeader = list
    .filter((cookie) => cookie?.name && cookie.value != null && !/[\r\n;]/.test(`${cookie.name}${cookie.value}`))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
  return {
    ok: true,
    uin,
    gtk: gtk(pSkey),
    cookieHeader,
    message: `已登录 QQ ${uin}`,
  }
}

export function parseQzoneBody(text) {
  const raw = String(text || '').trim()
  if (!raw) {
    throw new Error('QQ空间没有返回内容')
  }
  if (raw.startsWith('<')) {
    throw new Error('QQ空间返回了登录页，登录态已失效')
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('QQ空间返回了无法解析的内容')
  }
  return JSON.parse(raw.slice(start, end + 1))
}

export function qzoneOk(data) {
  const code = data?.code
  return code === 0 || code === '0'
}

export function qzoneMessage(data) {
  return redact(data?.message || data?.msg || (data?.code == null ? 'QQ空间没有返回结果' : `code=${data.code}`))
}

export function formatQzoneTime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const ms = n > 10_000_000_000 ? n : n * 1000
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms)).replace('T', ' ')
}

export function summarizePosts(data, limit) {
  const rows = Array.isArray(data?.msglist) ? data.msglist : []
  return rows.slice(0, limit).map((row) => ({
    tid: String(row?.tid || ''),
    content: String(row?.content || row?.con || '').replace(/<[^>]+>/g, '').trim().slice(0, 180),
    createdAt: formatQzoneTime(row?.created_time),
  }))
}

export function buildPublishBody({ uin, content, visibility, richval = '' }) {
  const right = visibilityRight(visibility)
  if (richval) {
    return new URLSearchParams({
      con: content,
      richtype: '1',
      richval,
      pic_template: '',
      special_url: '',
      subrichtype: '',
      feedversion: '1',
      ver: '1',
      ugc_right: right,
      to_sign: '0',
      to_tweet: '0',
      issyncweibo: '0',
      hostuin: uin,
      code_version: '1',
      format: 'json',
      qzreferrer: `https://user.qzone.qq.com/${uin}`,
    }).toString()
  }
  return new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    who: right === '1' ? '1' : right,
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: right,
    to_sign: '0',
    to_tweet: '0',
    issyncweibo: '0',
    hostuin: uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${uin}`,
  }).toString()
}

export function shanghaiDay(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

export async function takePublishSlot(file, options) {
  const now = options.now ?? Date.now()
  const day = shanghaiDay(now)
  await mkdir(path.dirname(file), { recursive: true })
  let state = { day, count: 0, lastAt: 0 }
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (saved && typeof saved === 'object') state = { ...state, ...saved }
  } catch {
    // 第一次发表还没有记录文件。
  }
  if (state.day !== day) {
    state = { day, count: 0, lastAt: 0 }
  }
  const elapsed = now - Number(state.lastAt || 0)
  if (Number(state.lastAt) > 0 && elapsed < options.minIntervalMs) {
    const wait = Math.ceil((options.minIntervalMs - elapsed) / 1000)
    return { ok: false, message: `距离上一条发表不足间隔，请 ${wait} 秒后再发。` }
  }
  if (Number(options.dailyLimit) > 0 && Number(state.count) >= options.dailyLimit) {
    return { ok: false, message: `今天已发表 ${state.count} 条，达到上限 ${options.dailyLimit}。` }
  }
  state.count = Number(state.count || 0) + 1
  state.lastAt = now
  await writeFile(file, JSON.stringify(state))
  return { ok: true }
}
