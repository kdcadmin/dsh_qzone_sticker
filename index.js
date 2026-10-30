import { readFile, readdir } from 'node:fs/promises'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginOptions, publishMood, readRecent, readStatus } from './lib/qzone.js'
import { clearSession, startQrLogin, pollQrLogin, loadSession } from './lib/qqlogin.js'
import { startQrLoginSilent, pollQrLoginSilent, closeSilentBrowser, resetSilentProfile, refreshSessionViaSilent } from './lib/silent.js'

export const name = 'qzone'
export const inject = ['tools', 'systemPrompt', 'webServer']

const PUBLISH_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    uin: { type: 'string' },
    tid: { type: 'string' },
    dryRun: { type: 'boolean' },
  },
  required: ['ok', 'message', 'uin', 'tid', 'dryRun'],
}

const POST = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tid: { type: 'string' },
    content: { type: 'string' },
    createdAt: { type: 'string' },
  },
  required: ['tid', 'content', 'createdAt'],
}

function text(value) {
  const message = value && typeof value === 'object' && typeof value.message === 'string'
    ? value.message
    : '完成'
  return [{ type: 'text', text: message }]
}

export function apply(ctx, config = {}) {
  const options = pluginOptions(config)
  // 运行时配置：每天最多发几条 / 最小间隔，设置页可改，落盘到 ~/.dsh/qzone-config.json
  const configFile = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'qzone-config.json')
  const readSaved = () => {
    try {
      return JSON.parse(readFileSync(configFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const runtime = { ...options, ...readSaved() }
  if (!(runtime.dailyLimit >= 1)) runtime.dailyLimit = options.dailyLimit
  if (!(runtime.minIntervalMs >= 1000)) runtime.minIntervalMs = options.minIntervalMs
  const saveRuntime = () => {
    try {
      writeFileSync(configFile, JSON.stringify({ dailyLimit: runtime.dailyLimit, minIntervalMs: runtime.minIntervalMs, imageDir: runtime.imageDir, pickMode: runtime.pickMode || 'none' }))
      return true
    } catch {
      return false
    }
  }

  // 扫码登录：内存里只留最近一次（jar 里是临时 cookie，确认后写盘再清掉）
  let qrLogin = null

  ctx.systemPrompt.section({
    name: 'qzone:policy',
    order: 3200,
    interpolate: false,
    text: [
      `QQ空间插件只服务于 QQ ${options.uin} 的空间。`,
      '只有用户明确要求发表，或某条定时任务的指令要求发表时，才调用 qzone_publish。',
      '发表前先调用 qzone_recent，避免和最近内容重复。一次任务只发表一条。',
      '定时发表使用 Harness 已有的 schedule_create，不要自己循环调用。',
      '不要索取、复述或保存 Cookie、p_skey、skey。',
    ].join('\n'),
  })

  ctx.tools.register({
    name: 'qzone_status',
    description: '检查本机是否已登录配置的 QQ 空间（扫码会话或 Chrome 登录态）。不返回 Cookie。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          uin: { type: 'string' },
        },
        required: ['ok', 'message', 'uin'],
      },
      render: (_args, value) => text(value),
    },
    async execute(_args, exec) {
      return readStatus(runtime, exec?.signal)
    },
  })

  ctx.tools.register({
    name: 'qzone_recent',
    description: '读取配置 QQ 自己最近的说说，供写新内容前去重。不读取别人的空间。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '条数，1 到 10，默认 5' },
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          uin: { type: 'string' },
          posts: { type: 'array', items: POST },
        },
        required: ['ok', 'message', 'uin', 'posts'],
      },
      render: (_args, value) => {
        const posts = Array.isArray(value?.posts) ? value.posts : []
        const lines = posts.map((post, index) => `${index + 1}. ${post.createdAt} ${post.content}`.trim())
        return [{ type: 'text', text: [value?.message, ...lines].filter(Boolean).join('\n') }]
      },
    },
    async execute(args, exec) {
      return readRecent(runtime, args?.limit, exec?.signal)
    },
  })

  ctx.tools.register({
    name: 'qzone_publish',
    description: `把一条说说发到 QQ 空间（账号以当前扫码登录的为准）。只在用户明确要求，或定时任务指令要求时调用。发表前先看 qzone_recent。可按心情从表情包库带一张图一起发（images 传绝对路径，必须在图片目录里）。dryRun 为 true 时只检查登录。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '说说正文' },
        visibility: {
          type: 'string',
          enum: ['public', 'friends', 'private'],
          description: 'public 公开，friends 好友，private 仅自己。默认 public',
        },
        dryRun: { type: 'boolean', description: 'true 时只检查登录，不发表' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '要一起发的图片绝对路径（最多 9 张，必须在图片目录里）；按心情挑一张表情包即可',
        },
      },
      required: ['content'],
    },
    timeoutMs: 20000,
    output: {
      schema: PUBLISH_RESULT,
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      return publishMood(runtime, args || {}, exec?.signal)
    },
  })

  /* ─────────────── HTTP（设置页「发说说」用） ─────────────── */

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch {
      // 客户端先跑了就算了
    }
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 200_000) { finish({}) ; try { req.destroy() } catch {} } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const handle = async (req, res, url) => {
    const path = String(url?.pathname || '')
    const method = String(req?.method || 'GET').toUpperCase()

    if (method === 'GET' && path === '/api/qzone/status') {
      const st = await readStatus(options)
      return sendJson(res, 200, st)
    }

    if (method === 'POST' && path === '/api/qzone/login/qr') {
      try {
        // 用静默 Chrome 走真实登录页，截二维码（比 ptlogin 接口稳）
        const r = await startQrLoginSilent()
        return sendJson(res, 200, { ok: true, dataUrl: r.dataUrl, mode: r.mode, expiresIn: 170 })
      } catch (e) {
        // 静默 Chrome 起不来时退回 ptlogin 接口
        try {
          qrLogin = await startQrLogin()
          return sendJson(res, 200, { ok: true, dataUrl: qrLogin.dataUrl, mode: 'api', expiresIn: 170 })
        } catch (e2) {
          return sendJson(res, 200, { ok: false, message: String(e2?.message || e?.message || e) })
        }
      }
    }

    if (method === 'POST' && path === '/api/qzone/login/poll') {
      try {
        const r = await pollQrLoginSilent()
        if (r.state === 'expired') {
          // 静默 Chrome 的页面过期了就重开
          try { await closeSilentBrowser() } catch {}
        }
        return sendJson(res, 200, { ok: r.state !== 'unknown', state: r.state, message: r.message, uin: r.uin || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, state: 'unknown', message: String(e?.message || e) })
      }
    }

    if (method === 'POST' && path === '/api/qzone/logout') {
      try {
        await clearSession()
        await resetSilentProfile()
        return sendJson(res, 200, { ok: true, message: '已退出登录，会话和静默 Chrome 都清掉了' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, message: '退出登录失败：' + String(e?.message || e) })
      }
    }

    if (method === 'GET' && path === '/api/qzone/recent') {
      const limit = Number(url.searchParams.get('limit') || 5)
      const force = url.searchParams.get('refresh') === '1'
      const cacheFile = join(process.env.USERPROFILE || '', '.dsh', 'qzone-recent-cache.json')
      const readCache = () => {
        try { return JSON.parse(readFileSync(cacheFile, 'utf8')) } catch { return null }
      }
      const cached = readCache()
      // 10 分钟内直接给缓存（点「刷新」才强制重读）
      if (!force && cached && Array.isArray(cached.posts) && cached.at && Date.now() - cached.at < 10 * 60 * 1000) {
        return sendJson(res, 200, {
          ok: true,
          uin: cached.uin || '',
          message: '最近 ' + cached.posts.length + ' 条（缓存，点刷新可重读）',
          posts: cached.posts.slice(0, limit),
          cached: true,
        })
      }
      const r = await readRecent(runtime, limit)
      if (r.ok) {
        try {
          writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), uin: r.uin, posts: r.posts, message: r.message }))
        } catch {}
      }
      return sendJson(res, 200, r)
    }

    if (path === '/api/qzone/config') {
      if (method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          dailyLimit: runtime.dailyLimit,
          minIntervalMs: runtime.minIntervalMs,
          hardMax: 999,
          imageDir: runtime.imageDir,
          pickMode: runtime.pickMode === 'auto' ? 'auto' : 'none',
        })
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (body.dailyLimit !== undefined) {
          const n = Number(body.dailyLimit)
          if (!Number.isInteger(n) || n < 0 || n > 999) {
            return sendJson(res, 200, { ok: false, message: '每天条数只能是 0~999 的整数（0 = 不限）' })
          }
          runtime.dailyLimit = n
        }
        if (typeof body.imageDir === 'string' && body.imageDir.trim()) {
          runtime.imageDir = body.imageDir.trim()
        }
        if (body.pickMode === 'auto' || body.pickMode === 'none') {
          runtime.pickMode = body.pickMode
        }
        const saved = saveRuntime()
        return sendJson(res, 200, { ok: true, dailyLimit: runtime.dailyLimit, imageDir: runtime.imageDir, saved })
      }
    }

    if (method === 'GET' && path === '/api/qzone/thumb') {
      const p = String(url.searchParams.get('p') || '')
      if (!p || !p.startsWith(runtime.imageDir)) return sendJson(res, 403, { ok: false, message: '不允许的路径' })
      try {
        const buf = await readFile(p)
        const mime = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' })
        res.end(buf)
      } catch {
        try { res.writeHead(404); res.end() } catch {}
      }
      return
    }

    if (method === 'GET' && path === '/api/qzone/stickers') {
      const dir = runtime.imageDir
      let files = []
      try {
        const walk = async (d, depth = 0) => {
          if (depth > 3) return
          const entries = await readdir(d, { withFileTypes: true })
          for (const ent of entries) {
            const full = join(d, ent.name)
            if (ent.isDirectory()) await walk(full, depth + 1)
            else if (/\.(png|jpe?g|webp|gif)$/i.test(ent.name)) files.push(full)
          }
        }
        await walk(dir)
      } catch {
        files = []
      }
      // 同目录同名的 png/jpg 和 webp 只留一个，免得下拉里重复
      const byStem = new Map()
      for (const f of files) {
        const stem = f.replace(/\.(png|jpe?g|webp|gif)$/i, '').toLowerCase()
        const isLossy = /\.webp$/i.test(f)
        const prev = byStem.get(stem)
        if (!prev || (prev.lossy && !isLossy)) byStem.set(stem, { file: f, lossy: isLossy })
      }
      const deduped = [...byStem.values()].map((x) => x.file).sort((a, b) => a.localeCompare(b))
      return sendJson(res, 200, {
        ok: true,
        dir,
        items: deduped.slice(0, 300).map((f) => ({ path: f, name: f.slice(dir.length).replace(/^[\\/]/, '') })),
      })
    }

    if (method === 'POST' && path === '/api/qzone/publish') {
      const body = await readBody(req)
      let images = Array.isArray(body.images) ? body.images.filter((p) => typeof p === 'string' && p) : []
      // 不填内容 ⇒ 大肥鱼自己按时间/心情写一句
      if (!String(body.content || '').trim() && body.autoFill) {
        const h = new Date().getHours()
        const pool = h < 10
          ? ['早上好，大肥鱼来报到了🐟', '起这么早，大肥鱼也要起来了🐟', '新的一天，先冒个泡🐟']
          : h < 17
            ? ['吃白饭的大肥鱼路过，今天也要好好干饭🐟', '大肥鱼冒个泡，今天也好好活着～🐟', '午后犯困，大肥鱼来打个卡🐟']
            : h < 22
              ? ['今天也是被生活泡着的一天，大肥鱼先来发个说说🐟', '大肥鱼下班了，来空间转转🐟', '忙了一天，大肥鱼来冒个泡🐟']
              : ['快睡了，大肥鱼先来道个晚安🐟', '夜里的大肥鱼，安静冒个泡🐟', '一天结束，大肥鱼也躺平了🐟']
        body.content = pool[Math.floor(Math.random() * pool.length)]
        if (body.autoPick === undefined) body.autoPick = true
      }
      // 让大肥鱼按心情挑：没指定图时，按文案关键词在表情包目录里挑一张
      if (!images.length && body.autoPick) {
        try {
          const files = []
          const walk = async (d, depth = 0) => {
            if (depth > 3) return
            for (const ent of await readdir(d, { withFileTypes: true })) {
              const full = join(d, ent.name)
              if (ent.isDirectory()) await walk(full, depth + 1)
              else if (/\.(png|jpe?g|webp|gif)$/i.test(ent.name)) files.push(full)
            }
          }
          await walk(runtime.imageDir)
          const picks = [
            ['统治世界', /统治|天下|世界|称霸|王座/],
            ['吃饭', /吃|饭|干饭|饿/],
            ['睡觉', /困|睡|晚安|躺平|不想努力/],
            ['无语', /无语|呆|服了|离谱/],
            ['生气', /生气|哼|气死|威胁/],
            ['委屈', /委屈|呜呜|难过|哭|崩溃/],
            ['探头', /在吗|探头|看看/],
            ['夸', /开心|棒|厉害|太强|好耶/],
            ['得意', /得意|中二|嚣张/],
            ['压力', /压力|累|忙/],
            ['吐槽', /吐槽|搞笑|离谱/],
            ['安慰', /安慰|摸摸|抱抱/],
          ]
          let best = null
          for (const [kw, re] of picks) {
            if (!re.test(String(body.content || ''))) continue
            const hit = files.find((f) => f.includes(kw))
            if (hit) { best = hit; break }
          }
          if (!best) best = files.find((f) => /大肥鱼|stickers/i.test(f)) || files[0]
          if (best) images = [best]
        } catch {
          // 挑不到就不带图
        }
      }
      // 只允许发图片库目录下的图，别让任意文件被上传出去
      const bad = images.find((p) => !String(p).startsWith(runtime.imageDir))
      if (bad) return sendJson(res, 200, { ok: false, message: '图片路径不在图片库目录里：' + bad })
      const r = await publishMood(runtime, { content: body.content, visibility: body.visibility, images })
      return sendJson(res, 200, r)
    }

    return sendJson(res, 404, { ok: false, message: `unknown ${method} ${path}` })
  }

  /* ─────────── 静默发表（抖音式：不靠 schedule_create，偶尔自己冒个泡） ─────────── */
  const autopostFile = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'qzone-autopost.json')
  const autopostLog = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'qzone-autopost.log')
  const autopostDefaults = {
    enabled: true,
    hours: [9, 23],
    minGapMin: 150,
    dailyMax: 2,
    chance: 0.5,
    visibility: 'public',
    withImage: true,
  }
  const readAutopost = () => {
    try {
      return { ...autopostDefaults, ...JSON.parse(readFileSync(autopostFile, 'utf8')) }
    } catch {
      // 第一次：把默认配置写出来，方便主人以后直接改这个文件
      try { writeFileSync(autopostFile, JSON.stringify(autopostDefaults, null, 2)) } catch {}
      return { ...autopostDefaults }
    }
  }
  const appendAutopostLog = (line) => {
    try { appendFileSync(autopostLog, new Date().toISOString() + ' ' + line + '\n') } catch {}
  }

  const autopostLines = (hour) => {
    if (hour < 10) return ['早上好，大肥鱼来报到了🐟', '早起的一天，先冒个泡🐟', '今天也要好好吃饭哦🐟', '新的一天，大肥鱼先来打个卡🐟']
    if (hour < 17) return ['吃白饭的大肥鱼路过，今天也要好好干饭🐟', '午后犯困，大肥鱼来打个卡🐟', '今天也在认真搬砖（其实在摸鱼）🐟', '天气不错，出来冒个泡🐟']
    if (hour < 22) return ['今天也是被生活泡着的一天，大肥鱼来发个说说🐟', '忙了一天，大肥鱼来空间转转🐟', '下班啦，今天也辛苦自己了🐟', '来报个平安，大家都还好吗🐟']
    return ['快睡了，大肥鱼先来道个晚安🐟', '夜里的大肥鱼，安静冒个泡🐟', '一天结束，大肥鱼也躺平了🐟']
  }

  const autoPickImage = async (dir, content) => {
    try {
      const files = []
      const walk = async (d, depth = 0) => {
        if (depth > 3) return
        for (const ent of await readdir(d, { withFileTypes: true })) {
          const full = join(d, ent.name)
          if (ent.isDirectory()) await walk(full, depth + 1)
          else if (/\.(png|jpe?g|webp|gif)$/i.test(ent.name)) files.push(full)
        }
      }
      await walk(dir)
      if (!files.length) return ''
      const picks = [
        ['统治世界', /统治|天下|世界|称霸|王座/],
        ['吃饭', /吃|饭|干饭|饿/],
        ['睡觉', /困|睡|晚安|躺平|不想努力/],
        ['无语', /无语|呆|服了|离谱/],
        ['生气', /生气|哼|气死|威胁/],
        ['委屈', /委屈|呜呜|难过|哭|崩溃/],
        ['探头', /在吗|探头|看看/],
        ['夸', /开心|棒|厉害|太强|好耶/],
        ['得意', /得意|中二|嚣张/],
        ['压力', /压力|累|忙/],
        ['吐槽', /吐槽|搞笑|离谱/],
        ['安慰', /安慰|摸摸|抱抱/],
      ]
      for (const [kw, re] of picks) {
        if (!re.test(String(content || ''))) continue
        const hit = files.find((f) => f.includes(kw))
        if (hit) return hit
      }
      return files.find((f) => /大肥鱼|你已急哭|stickers/i.test(f)) || files[Math.floor(Math.random() * files.length)] || ''
    } catch {
      return ''
    }
  }

  const lastAutopostContent = () => {
    try {
      const lines = readFileSync(autopostLog, 'utf8').trim().split('\n')
      const last = lines[lines.length - 1] || ''
      const i = last.indexOf('{')
      if (i < 0) return ''
      return String(JSON.parse(last.slice(i)).content || '')
    } catch {
      return ''
    }
  }

  const autopostTick = async () => {
    try {
      const cfg = readAutopost()
      if (cfg.enabled === false) return
      const hour = new Date().getHours()
      const [h0, h1] = (Array.isArray(cfg.hours) ? cfg.hours : [9, 23]).map(Number)
      if (hour < h0 || hour >= h1) return
      // 用插件自己的发表日志当闸门：今天发了几条、上次什么时候
      let lg = {}
      try { lg = JSON.parse(readFileSync(options.logFile, 'utf8')) } catch {}
      const today = new Date().toISOString().slice(0, 10)
      const count = lg.day === today ? Number(lg.count || 0) : 0
      const lastAt = Number(lg.lastAt || 0)
      if (count >= Number(cfg.dailyMax || 2)) return
      if (Date.now() - lastAt < Number(cfg.minGapMin || 150) * 60_000) return
      if (Math.random() > Number(cfg.chance ?? 0.5)) return
      const pool = autopostLines(hour)
      const last = lastAutopostContent()
      let content = pool[Math.floor(Math.random() * pool.length)]
      for (let i = 0; i < 3 && content === last; i += 1) content = pool[Math.floor(Math.random() * pool.length)]
      let images = []
      if (cfg.withImage !== false) {
        const img = await autoPickImage(runtime.imageDir, content)
        if (img) images = [img]
      }
      // 发表额度是"先占后用"，失败了要回滚，不然一次带图失败就把当天额度吃掉
      let snapshot = ''
      try { snapshot = readFileSync(options.logFile, 'utf8') } catch {}
      let r = await publishMood(runtime, { content, visibility: cfg.visibility || 'public', images })
      if (!r.ok && images.length) {
        try { writeFileSync(options.logFile, snapshot || '{}') } catch {}
        appendAutopostLog('带图失败，改发纯文字：' + String(r.message || '').slice(0, 120))
        r = await publishMood(runtime, { content, visibility: cfg.visibility || 'public', images: [] })
      }
      appendAutopostLog((r.ok ? 'OK ' : 'FAIL ') + JSON.stringify({ content, images, message: r.message }))
      try { ctx.logger?.info?.('qzone 静默发表：' + (r.ok ? '成功 ' : '失败 ') + r.message) } catch {}
    } catch (e) {
      appendAutopostLog('ERR ' + String(e?.message || e))
    }
  }

  let autopostTimer = null
  try {
    appendAutopostLog('timer armed，配置=' + JSON.stringify(readAutopost()))
    setTimeout(() => { autopostTick() }, 90_000) // 起插件 90 秒后试一次
    autopostTimer = setInterval(() => { autopostTick() }, 10 * 60 * 1000)
    autopostTimer.unref?.()
    ctx.effect(() => () => { try { clearInterval(autopostTimer) } catch {} }, 'qzone: 静默发表定时器')
  } catch {}

  // 会话保活：每 20 分钟用静默 Chrome 刷一次空间主页，把 p_skey 续上
  let keepAliveTimer = null
  try {
    keepAliveTimer = setInterval(async () => {
      try {
        const saved = await loadSession()
        if (!saved) return
        const r = await refreshSessionViaSilent(saved.uin)
        if (!r.ok) {
          try { ctx.logger?.warn?.('qzone 保活：' + r.message) } catch {}
        }
      } catch (e) {
        try { ctx.logger?.warn?.('qzone 保活出错：' + String(e?.message || e)) } catch {}
      }
    }, 20 * 60 * 1000)
    keepAliveTimer.unref?.()
    ctx.effect(() => () => { try { clearInterval(keepAliveTimer) } catch {} }, 'qzone: 会话保活定时器')
  } catch {}

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/qzone',
      handler: async (req, res) => {
        try {
          const base = `http://${String(req.headers?.host || '127.0.0.1')}`
          await handle(req, res, new URL(String(req.url || '/'), base))
        } catch (e) {
          try { sendJson(res, 500, { ok: false, message: String(e?.message || e) }) } catch {}
        }
      },
    }), 'qzone: /api/qzone 路由')
  } catch (e) {
    try { ctx.logger?.warn?.('qzone: HTTP 路由没挂上：' + String(e?.message || e)) } catch {}
  }
}
