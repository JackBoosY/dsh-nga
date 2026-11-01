// dsh-nga 的客户端那半：设置里加一格「NGA」，放登录表单和状态。
//
// 这个文件不打包：它是 __ModuleLoader__ 能直接吃的普通 JS。
// 只用 React 的 createElement，不引 ui-primitives，减少依赖。
window.__ModuleLoader__.load({
  id: 'dsh-nga',
  factory: (require) => {
    const React = require('react')
    const e = React.createElement
    const h = React.createElement

    const route = '/api/nga'

    async function api(action, body) {
      const url = `${route}?action=${encodeURIComponent(action)}`
      const init = body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' }
      const res = await fetch(url, init)
      const json = await res.json().catch(() => ({}))
      if (!res.ok && !json.error) throw new Error(`HTTP ${res.status}`)
      if (json.error) throw new Error(json.error)
      return json
    }

    const st = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { width: '72px', flex: 'none', fontSize: '13px', opacity: 0.8 },
      input: { flex: '1', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit' },
      btn: { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btnPrimary: { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.45)', background: 'rgba(128,128,128,.18)', color: 'inherit', cursor: 'pointer' },
      caption: { fontSize: '12px', opacity: 0.65, lineHeight: 1.6 },
      error: { fontSize: '13px', color: '#d05656' },
      ok: { fontSize: '13px', color: '#4a9c5f' },
      img: { border: '1px solid rgba(128,128,128,.35)', borderRadius: '6px', height: '60px' },
    }

    function NgaSection() {
      const [status, setStatus] = React.useState({ loading: true, configured: false, uid: '' })
      const [account, setAccount] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [rid, setRid] = React.useState('')
      const [image, setImage] = React.useState('')
      const [code, setCode] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [patrol, setPatrol] = React.useState(null)
      const [patrolBusy, setPatrolBusy] = React.useState(false)
      const [patrolError, setPatrolError] = React.useState('')
      const [realPost, setRealPost] = React.useState(false)
      const [replyText, setReplyText] = React.useState('提示：此账号只发主题、无任何回复记录')
      const timer = React.useRef(null)

      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

      React.useEffect(() => {
        let alive = true
        api('status')
          .then(v => { if (alive) setStatus({ loading: false, configured: Boolean(v.configured), uid: v.uid || '' }) })
          .catch(err => { if (alive) { setStatus({ loading: false, configured: false, uid: '' }); setError(String(err.message || err)) } })
        return () => { alive = false }
      }, [])

      const getCaptcha = async () => {
        setBusy('captcha'); setError(''); setNotice(''); setCode('')
        try {
          const v = await api('captcha', {})
          setRid(v.rid || '')
          setImage(v.image || '')
        } catch (err) { setError(String(err.message || err)) }
        setBusy('')
      }

      const doLogin = async () => {
        if (!rid || !image) { setError('先点「拿验证码」'); return }
        if (!account.trim() || !password) { setError('账号和密码都要填'); return }
        if (!code.trim()) { setError('把图上的字填进来'); return }
        setBusy('login'); setError(''); setNotice('')
        try {
          const v = await api('login', { name: account.trim(), password, rid, captcha: code.trim() })
          if (v.ok) {
            setStatus({ loading: false, configured: true, uid: v.uid || '' })
            setPassword(''); setCode(''); setImage(''); setRid('')
            setNotice('登录成功')
          } else {
            setError(v.message || '登录失败')
            setImage(''); setRid('')
          }
        } catch (err) { setError(String(err.message || err)) }
        setBusy('')
      }

      const doLogout = async () => {
        setBusy('logout'); setError(''); setNotice('')
        try {
          await api('logout', {})
          setStatus({ loading: false, configured: false, uid: '' })
          setNotice('已退出')
        } catch (err) { setError(String(err.message || err)) }
        setBusy('')
      }

      const runPatrol = async () => {
        setPatrolBusy(true); setPatrolError(''); setPatrol(null)
        try {
          const v = await api('patrol', {
            fid: '-7',
            page: 1,
            maxUsers: 12,
            dryRun: !realPost,
            text: replyText,
          })
          if (v.ok === false) { setPatrolError(v.error || '跑失败了'); setPatrolBusy(false); return }
          pollPatrol()
        } catch (err) { setPatrolError(String(err.message || err)); setPatrolBusy(false) }
      }

      const pollPatrol = () => {
        const tick = async () => {
          try {
            const s = await api('patrolStatus')
            if (s && !s.empty) setPatrol(s)
            if (s && s.running) {
              timer.current = setTimeout(tick, 1500)
            } else {
              timer.current = null
              setPatrolBusy(false)
            }
          } catch (err) {
            setPatrolError(String(err.message || err))
            timer.current = null
            setPatrolBusy(false)
          }
        }
        tick()
      }

      const cancelPatrol = async () => {
        try { await api('patrolCancel', {}) } catch (err) { setPatrolError(String(err.message || err)) }
      }

      const head = h('div', null,
        h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, 'NGA'),
        h('div', { style: st.caption }, '登录一次，之后就能让我读 NGA 的帖子。凭证只存在本机。'),
      )

      const statusLine = status.loading
        ? h('div', { style: st.caption }, '正在看登录状态…')
        : status.configured
          ? h('div', { style: st.ok }, `已登录：uid ${status.uid}`)
          : h('div', { style: st.caption }, '还没登录。')

      const loggedIn = status.configured

      const form = loggedIn
        ? h('div', { style: st.row },
            h('button', { style: st.btn, disabled: Boolean(busy), onClick: doLogout }, busy === 'logout' ? '退出中…' : '退出登录'),
          )
        : h('div', { style: st.wrap },
            h('div', { style: st.row },
              h('span', { style: st.label }, '账号'),
              h('input', {
                style: st.input, value: account, placeholder: '用户名或手机/邮箱',
                autoComplete: 'username',
                onChange: ev => setAccount(ev.target.value),
              }),
            ),
            h('div', { style: st.row },
              h('span', { style: st.label }, '密码'),
              h('input', {
                style: st.input, type: 'password', value: password, placeholder: '不会显示',
                autoComplete: 'current-password',
                onChange: ev => setPassword(ev.target.value),
              }),
            ),
            h('div', { style: st.row },
              h('span', { style: st.label }, '验证码'),
              image
                ? h('img', { src: image, style: st.img, alt: '验证码' })
                : h('span', { style: st.caption }, '点右边拿一张'),
              h('button', { style: st.btn, disabled: Boolean(busy), onClick: getCaptcha }, busy === 'captcha' ? '取图中…' : (image ? '换一张' : '拿验证码')),
            ),
            image
              ? h('div', { style: st.row },
                  h('span', { style: st.label }, '图上是'),
                  h('input', {
                    style: { ...st.input, maxWidth: '160px' }, value: code, placeholder: '照图填',
                    autoComplete: 'off',
                    onChange: ev => setCode(ev.target.value),
                  }),
                )
              : null,
            h('div', { style: st.row },
              h('button', { style: st.btnPrimary, disabled: Boolean(busy) || !image, onClick: doLogin }, busy === 'login' ? '登录中…' : '登录'),
            ),
            h('div', { style: st.caption }, '验证码要你自己看、自己填——我不会去认那串字。'),
          )

      const patrolBlock = loggedIn
        ? h('div', { style: { ...st.wrap, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: '12px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '巡检机器人'),
            h('div', { style: st.caption },
              '拉版面第一页 → 挨个查楼主的发帖记录 → 主题 ≥3 个且从没回过帖的，记为可疑。',
              h('br'),
              '实测这个版块里基本没有这种号，跑一轮多半是空转。',
            ),
            h('div', { style: st.row },
              h('span', { style: st.label }, '要发的'),
              h('input', {
                style: st.input, value: replyText,
                onChange: ev => setReplyText(ev.target.value),
              }),
            ),
            h('div', { style: st.row },
              h('label', { style: { ...st.caption, display: 'flex', alignItems: 'center', gap: '6px' } },
                h('input', {
                  type: 'checkbox', checked: realPost,
                  onChange: ev => setRealPost(ev.target.checked),
                }),
                '真的发出去（不勾只报告，不碰账号）',
              ),
            ),
            h('div', { style: st.row },
              h('button', {
                style: realPost ? st.btnPrimary : st.btn,
                disabled: patrolBusy && !patrol,
                onClick: runPatrol,
              }, patrolBusy ? '跑着…' : '跑一轮巡检'),
              patrolBusy
                ? h('button', { style: st.btn, onClick: cancelPatrol }, '取消这轮')
                : null,
            ),
            patrolError ? h('div', { style: st.error }, patrolError) : null,
            patrol
              ? h('div', null,
                  h('div', { style: st.caption },
                    `${patrol.running ? '正在跑' : '跑完了'}：查了 ${patrol.checked ?? 0} / ${patrol.totalOperators ?? '?'} 个楼主，`
                    + `可疑 ${patrol.candidates ?? 0} 个`
                    + `${patrol.dryRun ? '（只报告，没发）' : `，已发 ${patrol.posted ?? 0} 条`}`
                    + `${patrol.stopped ? '，已取消' : ''}`
                    + `${patrol.error ? `，出错：${patrol.error}` : ''}`,
                  ),
                  ...(patrol.results || []).map((r, i) => h('div', {
                    key: String(r.uid) + i,
                    style: { fontSize: '12px', opacity: r.verdict && r.verdict.startsWith('★') ? 1 : 0.7, lineHeight: 1.7 },
                  },
                    `${r.author || r.uid}　主题 ${r.topics ?? '?'}　回复 ${r.posts ?? '?'}　${r.verdict || ''}`
                    + `${r.replied === true ? '　已回' : r.replied === false ? `　发失败：${r.replyMessage || ''}` : ''}`,
                  )),
                )
              : null,
          )
        : null

      return h('div', { style: st.wrap },
        head,
        statusLine,
        form,
        error ? h('div', { style: st.error }, error) : null,
        notice ? h('div', { style: st.ok }, notice) : null,
        patrolBlock,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-nga',
        order: 60,
        label: () => 'NGA',
      }, NgaSection))
    }

    return { apply, inject }
  },
})
