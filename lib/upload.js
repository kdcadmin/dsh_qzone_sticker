// QQ空间图片上传 + 带图说说：先传图拿 url/picId，再用 richtype=1 & richval 发表
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UPLOAD_URL = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'

function parseJsonLoose(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('QQ空间图片接口返回无法解析：' + raw.slice(0, 120))
  return JSON.parse(raw.slice(start, end + 1))
}

/** 上传一张本地图片，返回 { url, width, height, picId } */
export async function uploadImage(session, filePath, signal) {
  const bytes = await readFile(filePath)
  const name = path.basename(filePath)
  const type = /\.png$/i.test(name) ? 'image/png' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg'
  const form = new FormData()
  form.append('filename', new Blob([bytes], { type }), name)
  form.append('uploadtype', '1')
  form.append('albumid', '0')
  form.append('batchid', String(Date.now()))
  form.append('uin', session.uin)
  form.append('pf', 'myqq')
  form.append('fwin', '1')
  form.append('qzonehidden', '0')
  form.append('referer', 'qzone')
  const url = `${UPLOAD_URL}?g_tk=${encodeURIComponent(session.gtk)}&uin=${encodeURIComponent(session.uin)}`
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal,
    headers: {
      'User-Agent': UA,
      Cookie: session.cookieHeader,
      Referer: `https://user.qzone.qq.com/${session.uin}`,
      Origin: 'https://user.qzone.qq.com',
    },
  })
  const text = await res.text()
  const data = parseJsonLoose(text)
  const pic = data?.data || data
  const picUrl = pic?.url || pic?.picUrl || pic?.pic_url || ''
  if (!picUrl) throw new Error('图片上传失败：' + String(data?.message || data?.msg || text.slice(0, 160)))
  return {
    url: String(picUrl).replace(/^http:/, 'https:'),
    width: Number(pic?.width || 0),
    height: Number(pic?.height || 0),
    picId: String(pic?.picId || pic?.picid || pic?.pic_id || ''),
  }
}

/** 组发表时用的 richval（按 Qzone 网页格式） */
export function buildRichval(pics) {
  const out = {}
  pics.forEach((pic, i) => {
    out[String(i)] = {
      url: pic.url,
      width: String(pic.width || 0),
      height: String(pic.height || 0),
      ...(pic.picId ? { picId: pic.picId } : {}),
    }
  })
  return JSON.stringify(out)
}
