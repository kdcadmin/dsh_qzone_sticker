/**
 * dsh-qzone —— 浏览器半端（「设置」里的一页：发说说）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（跟 dsh-douyin-life / dsh-bili-scroll 同一套约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * ⭐ 进「设置」= 往 settings.section 槽位注册一项；label 就是左侧导航那一行。
 * ⭐ 面板：顶部状态 + 扫码登录（二维码） + 最近说说 + 发一条。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-qzone',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/qzone'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-qz-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 10px;max-width:660px;}
[data-qz-top]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-qz-badge]{font-size:11px;opacity:.7;border:1px solid rgba(128,128,128,.35);border-radius:999px;padding:1px 8px;}
[data-qz-badge][data-ok]{border-color:rgba(80,180,120,.6);color:#3f9d6a;}
[data-qz-badge][data-bad]{border-color:rgba(210,90,90,.6);color:#c05555;}
[data-qz-card]{border:1px solid rgba(128,128,128,.22);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
[data-qz-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-qz-title]{font-size:13px;font-weight:600;}
[data-qz-note]{font-size:12px;opacity:.65;line-height:1.6;}
[data-qz-btn]{font-size:12.5px;padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;}
[data-qz-btn]:disabled{opacity:.45;cursor:not-allowed;}
[data-qz-btn][data-primary]{background:var(--dsh-accent,#4b6bfb);border-color:transparent;color:#fff;}
[data-qz-qr]{display:flex;gap:14px;align-items:center;}
[data-qz-qr] img{width:170px;height:170px;image-rendering:pixelated;border-radius:10px;background:#fff;padding:6px;}
[data-qz-textarea]{width:100%;min-height:86px;resize:vertical;border-radius:10px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.06);color:inherit;font-size:13px;padding:10px 12px;font-family:inherit;}
[data-qz-select]{border-radius:8px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font-size:12.5px;padding:5px 8px;}
[data-qz-posts]{display:flex;flex-direction:column;gap:6px;}
[data-qz-post]{font-size:12.5px;line-height:1.6;border-bottom:1px dashed rgba(128,128,128,.2);padding-bottom:6px;}
[data-qz-post] b{opacity:.55;font-weight:500;margin-right:8px;}
[data-qz-msg]{font-size:12.5px;line-height:1.6;opacity:.85;}
[data-qz-msg][data-warn]{color:#c05555;}
`

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [qr, setQr] = React.useState(null)
      const [qrState, setQrState] = React.useState('')
      const [posts, setPosts] = React.useState(null)
      const [text, setText] = React.useState('')
      const [stickers, setStickers] = React.useState([])
      const [limit, setLimit] = React.useState(0)
      const [imageDir, setImageDir] = React.useState('')
      const [pick, setPick] = React.useState('')
      const [visibility, setVisibility] = React.useState('public')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const loadStatus = React.useCallback(async () => {
        try { setStatus(await jget('/status')) } catch (e) { setStatus({ ok: false, message: String(e.message || e) }) }
      }, [])
      const loadPosts = React.useCallback(async () => {
        try { setPosts(await jget('/recent?limit=5')) } catch (e) { setPosts({ ok: false, message: String(e.message || e), posts: [] }) }
      }, [])

      React.useEffect(() => { loadStatus(); loadPosts() }, [loadStatus, loadPosts])
      // 没登录时每 5 秒问一次，扫码成功徽章会自动变
      React.useEffect(() => {
        if (status && status.ok) return undefined
        const t = setInterval(() => { loadStatus() }, 5000)
        return () => clearInterval(t)
      }, [status, loadStatus])
      React.useEffect(() => {
        let alive = true
        jget('/config').then(
          (r) => { if (alive && r && r.ok) { setLimit(Number(r.dailyLimit) || 0); setImageDir(String(r.imageDir || '')) } },
          () => {},
        )
        return () => { alive = false }
      }, [])
      React.useEffect(() => {
        let alive = true
        jget('/stickers').then(
          (r) => { if (alive && r && Array.isArray(r.items)) setStickers(r.items) },
          () => {},
        )
        return () => { alive = false }
      }, [])

      const startLogin = async () => {
        setBusy(true); setMsg(''); setQr(null); setQrState('')
        try {
          const r = await jpost('/login/qr', {})
          if (!r.ok) throw new Error(r.message || '生成二维码失败')
          setQr(r.dataUrl)
          setQrState('waiting')
        } catch (e) { setMsg('生成二维码失败：' + String(e.message || e)) } finally { setBusy(false) }
      }

      // 二维码在时每 2 秒问一次
      React.useEffect(() => {
        if (!qr || qrState === 'confirmed' || qrState === 'expired') return undefined
        let alive = true
        const t = setInterval(async () => {
          try {
            const r = await jpost('/login/poll', {})
            if (!alive) return
            if (r.state && r.state !== qrState) setQrState(r.state)
            if (r.message) setMsg(r.message)
            if (r.state === 'confirmed') { loadStatus(); loadPosts() }
            if (r.state === 'expired') setQr(null)
          } catch {
            // 轮询失败继续等
          }
        }, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [qr, qrState, loadStatus, loadPosts])

      const publish = async () => {
        const content = text.trim()
        if (!content) { setMsg('先写点内容'); return }
        setBusy(true); setMsg('')
        try {
          const autoPick = pick === 'auto'
          const r = await jpost('/publish', {
            content,
            visibility,
            images: pick && !autoPick ? [pick] : [],
            autoPick,
          })
          setMsg(r.message || (r.ok ? '已发表' : '发表失败'))
          if (r.ok) { setText(''); loadPosts() }
        } catch (e) { setMsg('发表失败：' + String(e.message || e)) } finally { setBusy(false) }
      }

      const loggedIn = !!(status && status.ok)
      const qrHint = {
        waiting: '用手机 QQ 扫这个码（QQ 里点「扫一扫」）',
        scanned: '已扫码，请在手机 QQ 上点「允许登录」',
        confirmed: '登录成功',
        expired: '二维码过期了，重新生成一个',
      }[qrState] || ''

      const saveLimit = async () => {
        setBusy(true); setMsg('')
        try {
          const r = await jpost('/config', { dailyLimit: Number(limit), imageDir })
          setMsg(r.ok ? ('已保存：每天最多发 ' + (r.dailyLimit > 0 ? r.dailyLimit + ' 条' : '不限') ) : (r.message || '保存失败'))
        } catch (e) { setMsg('保存失败：' + String(e.message || e)) } finally { setBusy(false) }
      }

      const logout = async () => {
        if (!window.confirm('退出登录会清掉本机会话和静默 Chrome 的登录态，下次要重新扫码。确定？')) return
        setBusy(true); setMsg('')
        try {
          const r = await jpost('/logout', {})
          setMsg(r.message || (r.ok ? '已退出登录' : '退出登录失败'))
          setQr(null); setQrState(''); setPosts(null)
          loadStatus()
        } catch (e) { setMsg('退出登录失败：' + String(e.message || e)) } finally { setBusy(false) }
      }

      return h('div', { 'data-qz-page': '' },
        h('div', { 'data-qz-top': '' },
          h('span', { 'data-qz-title': '' }, '发说说'),
          h('span', { 'data-qz-badge': '', 'data-ok': loggedIn ? '' : undefined, 'data-bad': loggedIn ? undefined : '' },
            loggedIn ? ('已登录 QQ ' + (status.uin || '')) : ('未登录' + (status && status.message ? '：' + status.message : ''))),
          loggedIn
            ? h('button', { 'data-qz-btn': '', disabled: busy, onClick: logout, style: { marginLeft: 'auto' } }, '退出登录')
            : null,
          h('span', { 'data-qz-badge': '' }, '公开/好友/仅自己'),),

        h('div', { 'data-qz-card': '' },
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-title': '' }, '扫码登录'),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy, onClick: startLogin },
              qr ? '重新生成二维码' : '生成登录二维码')),
          qr
            ? h('div', { 'data-qz-qr': '' },
              h('img', { src: qr, alt: 'QQ 登录二维码' }),
              h('div', { 'data-qz-note': '' }, qrHint))
            : h('div', { 'data-qz-note': '' },
              '手机 QQ 扫一扫就能登录，不用开 Chrome。登录态只存在本机 ',
              h('code', null, '%USERPROFILE%\\.dsh\\qzone-session.json'))),

        h('div', { 'data-qz-card': '' },
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-title': '' }, '每天最多发几条（0 = 不限）'),
            h('input', {
              type: 'number', min: 0, max: 999, value: limit,
              onChange: (e) => setLimit(e.target.value),
              style: { width: 72, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' },
            }),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy, onClick: saveLimit }, '保存'),
            h('span', { 'data-qz-note': '' }, '0 = 不限；建议 1~2 条，别刷屏')),
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-title': '' }, '表情包目录'),
            h('input', {
              type: 'text', value: imageDir, onChange: (e) => setImageDir(e.target.value),
              style: { flex: 1, minWidth: 240, padding: '5px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' },
            })),
          h('div', { 'data-qz-note': '' }, '配图从这个目录里挑；换电脑/换人用就改成自己的表情包文件夹。'),
          h('div', { 'data-qz-note': '' }, '还有两条之间的最小间隔 60 秒（防刷屏）。')),

        h('div', { 'data-qz-card': '' },
          h('div', { 'data-qz-title': '' }, '发一条'),
          h('textarea', {
            'data-qz-textarea': '', placeholder: '写点什么…（发之前会先读最近的说说，避免重复）',
            value: text, onChange: (e) => setText(e.target.value), maxLength: 2000,
          }),
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-note': '' }, '配图'),
            h('select', {
              'data-qz-select': '', value: pick, onChange: (e) => setPick(e.target.value),
              style: { maxWidth: 320 },
            },
              h('option', { value: '' }, '不带图'),
              h('option', { value: 'auto' }, '让大肥鱼按心情挑'),
              stickers.map((s) => h('option', { key: s.path, value: s.path }, s.name))),
            pick
              ? h('img', { src: '/api/qzone/thumb?p=' + encodeURIComponent(pick), alt: '', style: { width: 44, height: 44, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(128,128,128,.3)' } })
              : null),
          h('div', { 'data-qz-row': '' },
            h('select', { 'data-qz-select': '', value: visibility, onChange: (e) => setVisibility(e.target.value) },
              h('option', { value: 'public' }, '公开'),
              h('option', { value: 'friends' }, '好友'),
              h('option', { value: 'private' }, '仅自己')),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy || !loggedIn, onClick: publish },
              busy ? '发表中…' : '发表'),
            h('span', { 'data-qz-note': '' }, '每天最多 8 条，两条间隔 ≥60 秒')),
          msg ? h('div', { 'data-qz-msg': '', 'data-warn': msg.indexOf('失败') >= 0 ? '' : undefined }, msg) : null),

        h('div', { 'data-qz-card': '' },
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-title': '' }, '最近的说说'),
            h('button', { 'data-qz-btn': '', onClick: loadPosts }, '刷新')),
          posts && posts.ok
            ? h('div', { 'data-qz-posts': '' },
              (posts.posts || []).length
                ? posts.posts.map((p, i) => h('div', { 'data-qz-post': '', key: p.tid || i },
                  h('b', null, p.createdAt || ''), p.content || ''))
                : h('div', { 'data-qz-note': '' }, posts.message || '最近没有说说'))
            : h('div', { 'data-qz-note': '' }, posts ? (posts.message || '读不到') : '读取中…')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qzone')
        style.textContent = CSS
        document.head.appendChild(style)
        try { ctx.effect(() => () => style.remove(), 'dsh-qzone: 设置页样式') } catch { /* 忽略 */ }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'qzone', order: 34, label: '发说说' },
          () => h(Panel),
        ))
      },
    }
  },
})
