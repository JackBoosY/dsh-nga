// NGA 协议层：造 rid、取验证码、账号密码登录、读帖子
//
// 全部是抓包/读源码得来的真协议（见 memory/light-notes.md 第二十六节）：
//   rid  = 'login' + 毫秒时间戳 + 三位随机数（服务端认）
//   图   = GET /login_check_code.php?id=<rid>&from=login       -> image/png
//   登录 = POST /nuke.php  multipart：
//          __lib=login __output=1 app_id=5004 device= __act=login __inchst=UTF-8
//          trackid= __ngaClientChecksum= name=<账号> type= password=<RSA> rid=<rid> captcha=<人填>
//   读帖 = POST /read.php?tid=..&page=..  表单带 access_uid/access_token；UA 用 NGA_WP_JW/(;WINDOWS)
import { constants, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = 'https://bbs.nga.cn/'
const NUKE = BASE + 'nuke.php'
const READ_UA = 'NGA_WP_JW/(;WINDOWS)'

// 2026-11-01：光带 access_uid/token 会被 NGA 判成「不像浏览器」，用户页直接 503
// （连发几个就封，跟频率无关）。补齐浏览器的 UA / Accept / sec-fetch-* 之后 6/6、11/11 全过。
// 另外浏览器还带登录 cookie ngaPassportUid / ngaPassportCid，从 ~/.dsh/nga-creds.json 里取。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let cookieCache
/** 登录 cookie（浏览器里那套）。没有就返回空串，请求退回 token。 */
export function loadCookies() {
  if (cookieCache !== undefined) return cookieCache
  const parts = []
  const uid = process.env.NGA_COOKIE_UID
  const cid = process.env.NGA_COOKIE_CID
  if (uid) parts.push(`ngaPassportUid=${uid}`)
  if (cid) parts.push(`ngaPassportCid=${cid}`)
  if (!parts.length) {
    try {
      const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'nga-creds.json')
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      const u = j.cookie_uid || j.ngaPassportUid
      const k = j.cookie_cid || j.ngaPassportCid
      if (u) parts.push(`ngaPassportUid=${u}`)
      if (k) parts.push(`ngaPassportCid=${k}`)
    } catch { /* 没文件就算了 */ }
  }
  cookieCache = parts.join('; ')
  return cookieCache
}

/** 一套「像浏览器」的请求头。cookie 有就带上。 */
export function browserHeaders(referer) {
  const h = {
    'User-Agent': BROWSER_UA,
    'X-User-Agent': BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': referer || `${BASE}thread.php?fid=-7`,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  }
  const cookie = loadCookies()
  if (cookie) h['Cookie'] = cookie
  return h
}

const PASSPORT_PUBLIC_KEY = (
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyKzZWDimCN1OCprqWUhFUPhcwxDE62/BFVP6LtQHJu+65dm4YNmD'
  + 'vzitmcfaXW9YbhXnd4oP7j+6vpcgJQ+p3ucySo1ZnqO0Bb2JKEtxpCmxe7IYXhFEkJqHpFYBTiAxQz2n2mX4JZy/ehBUSMjzg'
  + 'zd0NdG6Ai1C42oCzYltUOjNWZUNHn1nqpElSWHnUWqkdN8+5ISP/ZMKiQdFANkEqDGw3/34qyF+E/hVgrGF4/CcWNP/LJCdB6'
  + 'DYtx7VPlQZF0tP1s+q/++rC4rQ2wmVl2V8zGh1j7ojZbt62hVjy6byK1E/2XYo97ZtL4KDW7F5jJMvSDRFR7901UR8hCdf4wID'
  + 'AQAB'
)
const PASSPORT_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'X-USER-AGENT': 'Mozilla/5.0',
  'Referer': `${BASE}nuke/account_copy.html?login`,
}

/** 造一个 rid。实测服务端认这种形状。 */
export function newRid() {
  return 'login' + String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0')
}

/** 密码 RSA(PKCS#1 v1.5) 加密后 base64。 */
export function rsaEncrypt(plain) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${PASSPORT_PUBLIC_KEY.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`
  return publicEncrypt({ key: createPublicKey(pem), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(String(plain), 'utf8')).toString('base64')
}

/** 取验证码图。返回 { contentType, bytes }。 */
export async function fetchCaptcha(rid, signal) {
  const url = `${BASE}login_check_code.php?id=${encodeURIComponent(rid)}&from=login`
  const res = await fetch(url, { headers: PASSPORT_HEADERS, signal })
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error(`取验证码失败: HTTP ${res.status}`)
  if (bytes[0] !== 0x89 && bytes.subarray(0, 3).toString('latin1') !== 'GIF') {
    throw new Error('取验证码返回的不是图片')
  }
  return { contentType: res.headers.get('content-type') || 'image/png', bytes }
}

function decodeBody(buf) {
  let body = buf.toString('utf8')
  if (body.includes('\uFFFD')) {
    try { body = new TextDecoder('gb18030').decode(buf) } catch { body = buf.toString('latin1') }
  }
  const marker = 'window.script_muti_get_var_store='
  if (body.startsWith(marker)) body = body.slice(marker.length)
  return body
}

function pickIdentity(data) {
  const payload = data && data.data
  const values = payload && typeof payload === 'object'
    ? (Array.isArray(payload) ? payload : Object.values(payload))
    : []
  for (let v of values) {
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try { v = JSON.parse(v.trim()) } catch { continue }
    }
    if (v && typeof v === 'object' && v.uid && v.token) return { uid: String(v.uid), token: String(v.token) }
  }
  return undefined
}

/** 账号密码登录。返回 { ok, uid, token } 或 { ok:false, message }。 */
export async function passwordLogin({ name, password, rid, captcha }, signal) {
  if (!name || !password) throw new Error('账号和密码都要填')
  if (!rid || !captcha) throw new Error('验证码还没填')

  const boundary = '----WebKitFormBoundary' + randomBytes(8).toString('hex')
  const fields = [
    ['__lib', 'login'], ['__output', '1'], ['app_id', '5004'], ['device', ''],
    ['__act', 'login'], ['__inchst', 'UTF-8'], ['trackid', ''],
    ['__ngaClientChecksum', ''], ['name', name], ['type', ''],
    ['password', rsaEncrypt(password)], ['rid', rid], ['captcha', captcha],
  ]
  const body = Buffer.concat([
    ...fields.map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8')),
    Buffer.from(`--${boundary}--\r\n`, 'utf8'),
  ])

  const res = await fetch(NUKE, {
    method: 'POST',
    headers: { ...PASSPORT_HEADERS, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  })
  const data = JSON.parse(decodeBody(Buffer.from(await res.arrayBuffer())))
  if (data && data.error) {
    const msg = typeof data.error === 'object' ? Object.values(data.error).join(' ') : String(data.error)
    return { ok: false, message: msg }
  }
  const ident = pickIdentity(data)
  if (!ident) return { ok: false, message: '登录接口回了，但没有 uid/token' }
  return { ok: true, ...ident }
}

/** 把 HTML 粗粗转成文本。 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(l => l.replace(/[ \t\u3000]+/g, ' ').trim()).filter(Boolean).join('\n')
}

// ---------- 楼层解析 ----------
// 结构（2026-11-01 用真实 HTML 核过）：
//   <tr id='post1strow0' class='postrow'>     每层一个
//     <a href='nuke.php?func=ucp&uid=41048233' id='postauthor0'>   作者 uid（名字不在标签里）
//     <span id='postdate0' title='reply time'>2019-08-27 06:49</span>
//     <h3 id='postsubject0'>…</h3>
//     <p id='postcontent0' class='postcontent ubbcode'>…</p>
//   用户名在头部 <script> 里：commonui.userInfo.setAll({"41048233":{"uid":…,"username":"…"}})

/** uid → 用户名。取不到的就不放进去（调用方自己兜底）。 */
export function parseUsers(html) {
  const out = {}
  const re = /"uid":(\d+),"username":"((?:[^"\\]|\\.)*)"/g
  for (const m of String(html).matchAll(re)) {
    try { out[m[1]] = JSON.parse(`"${m[2]}"`) } catch { out[m[1]] = m[2] }
  }
  return out
}

/** UBB 渲染出来的 HTML → 干净文本。引用块和图片单独标一下，别混进正文。 */
function ubbToText(html) {
  return htmlToText(String(html)
    .replace(/<div class=['"]quote['"][\s\S]*?<\/div>\s*<\/div>/gi, '\n[引用]\n')
    .replace(/<div class=['"]quote['"][\s\S]*?<\/div>/gi, '\n[引用]\n')
    .replace(/<img[^>]*>/gi, '[图]'))
}

/** 拆楼层。返回 [{ lou, index, uid, author, date, subject, content }]。 */
export function parseFloors(html) {
  const src = String(html)
  const users = parseUsers(src)
  const marks = []
  for (const m of src.matchAll(/<tr id='post\d+strow(\d+)'/g)) marks.push({ index: Number(m[1]), at: m.index })
  const floors = []
  for (let i = 0; i < marks.length; i++) {
    const seg = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length)
    const idx = marks[i].index
    const uid = (seg.match(/func=ucp&(?:amp;)?uid=(\d+)/) || [])[1] || ''
    const date = ((seg.match(/id='postdate\d+'[^>]*>([^<]*)</) || [])[1] || '').trim()
    const subject = htmlToText((seg.match(/id='postsubject\d+'[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '')
    // 正文容器是 p / div / span 都可能（楼主用 <p>，回复常是 <span>），所以按同名标签闭合来截
    const raw = (seg.match(/<(\w+) id='postcontent\d+'[^>]*>([\s\S]*?)<\/\1>/) || [])[2] ?? ''
    floors.push({ lou: idx, index: idx, uid, author: users[uid] || '', date, subject, content: ubbToText(raw) })
  }
  return floors
}

/** 帖子标题 / 版面 / 最大页码 / fid。 */
export function parseTopicMeta(html) {
  const src = String(html)
  const title = htmlToText((src.match(/id='currentTopicName'[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '')
  const forum = htmlToText((src.match(/id='currentForumName'[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || '')
  const fid = (src.match(/__CURRENT_FID=parseInt\('(-?\d+)'\)/) || [])[1] || ''
  let pages = 1
  for (const m of src.matchAll(/read\.php\?tid=\d+&(?:amp;)?page=(\d+)/g)) pages = Math.max(pages, Number(m[1]))
  return { title, forum, fid, pages }
}

/** 把一页楼层拼成给人/模型看的文本。 */
export function floorsToText(floors, { page = 1, pages = 1, total = 0 } = {}) {
  const head = [`第 ${page} 页${pages > 1 ? ` / 共 ${pages} 页` : ''}${total ? `，本页 ${total} 层` : ''}`]
  const body = floors.map((f) => {
    const who = f.author || (f.uid ? `uid ${f.uid}` : '匿名')
    const lou = f.lou === 0 ? '楼主' : `${f.lou} 楼`
    const sub = f.subject && f.subject !== '' ? `\n${f.subject}` : ''
    return `\n【${lou}】${who}${f.date ? '  ' + f.date : ''}${sub}\n${f.content || '(空)'}`
  })
  return head.concat(body).join('\n').trim()
}

async function fetchTopicPage({ tid, page = 1, authorId }, auth, signal) {
  const qs = new URLSearchParams({ tid: String(tid) })
  if (Number(page) > 1) qs.set('page', String(page))
  if (authorId) qs.set('authorid', String(authorId))
  const url = `${BASE}read.php?${qs.toString()}`
  const form = new URLSearchParams()
  if (auth && auth.uid) form.set('access_uid', auth.uid)
  if (auth && auth.token) form.set('access_token', auth.token)
  // read.php 用 NGA_WP_JW + token 那条路是通的（2026-11-01 实测），别换成浏览器头，会 403。
  const headers = { 'User-Agent': READ_UA, 'X-User-Agent': READ_UA, Referer: `${BASE}/`, 'Content-Type': 'application/x-www-form-urlencoded' }
  const res = await fetch(url, { method: 'POST', headers, body: form.toString(), signal })
  const buf = Buffer.from(await res.arrayBuffer())
  let html = buf.toString('utf8')
  if (html.includes('\uFFFD')) {
    try { html = new TextDecoder('gb18030').decode(buf) } catch { /* 保留 utf8 */ }
  }
  const meta = parseTopicMeta(html)
  const floors = parseFloors(html)
  const plain = htmlToText(html)
  return {
    status: res.status,
    bytes: buf.length,
    url,
    html,
    ...meta,
    floors,
    text: floors.length ? floorsToText(floors, { page: Number(page), pages: meta.pages, total: floors.length }) : plain,
    // 同上：只信状态码。正文里出现「未登录」可能只是别人的帖子内容。
    needsLogin: res.status === 403,
  }
}

/**
 * 读一个帖子。
 *   pages: 读多页，'1-3' 或 3（从 1 开始）或 [1,2]
 *   authorOnly: 只看楼主（自动取楼主 uid，再带 authorid 重读）
 * auth 是 { uid, token }。
 */
export async function readTopic({ tid, page = 1, pages, authorId, authorOnly, maxPages = 5 }, auth, signal) {
  if (!tid) throw new Error('要给 tid')
  const list = normalizePages(pages, page, maxPages)
  let effectiveAuthor = authorId ? String(authorId) : undefined
  const results = []
  for (const p of list) {
    let one = await fetchTopicPage({ tid, page: p, authorId: effectiveAuthor }, auth, signal)
    if (authorOnly && !effectiveAuthor) {
      const op = one.floors.find((f) => f.lou === 0 && f.uid) || one.floors.find((f) => f.uid)
      if (op && op.uid) {
        effectiveAuthor = op.uid
        one = await fetchTopicPage({ tid, page: p, authorId: effectiveAuthor }, auth, signal)
      }
    }
    results.push(one)
    if (one.needsLogin || one.status !== 200) break
  }
  const first = results[0] || { status: 0, floors: [], text: '', pages: 1, title: '', forum: '' }
  const text = results.map((r) => r.text).join('\n\n').trim()
  return {
    status: first.status,
    bytes: results.reduce((n, r) => n + (r.bytes || 0), 0),
    url: first.url,
    title: first.title,
    forum: first.forum,
    fid: first.fid || '',
    pages: Math.max(first.pages || 1, ...results.map((r) => r.pages || 1)),
    authorId: effectiveAuthor || '',
    floors: results.flatMap((r) => r.floors),
    text,
    needsLogin: first.needsLogin,
  }
}

/** '1-3' / 3 / [1,2] / 不给 → [page]；上限 maxPages 页。 */
export function normalizePages(pages, page = 1, maxPages = 5) {
  const cap = Math.max(1, Number(maxPages) || 5)
  if (pages == null || pages === '') return [Math.max(1, Number(page) || 1)]
  if (Array.isArray(pages)) return pages.map(Number).filter((n) => n >= 1).slice(0, cap).sort((a, b) => a - b)
  const s = String(pages).trim()
  const range = s.match(/^(\d+)\s*[-~]\s*(\d+)$/)
  if (range) {
    const from = Math.max(1, Number(range[1]))
    const to = Math.max(from, Number(range[2]))
    const out = []
    for (let n = from; n <= to && out.length < cap; n++) out.push(n)
    return out
  }
  const one = Number(s)
  return [Number.isFinite(one) && one >= 1 ? one : Math.max(1, Number(page) || 1)]
}

// ---------- 回复 ----------
// 协议（2026-11-01 用真请求试出来的）：
//   1) POST /post.php?action=reply&fid=<fid>&tid=<tid>（带 access_uid/token）
//      → 页面里有 var __U={…"auth":"<一次性口令>"…}；没有表单，是 JS 现拼的
//   2) POST 同一个 URL，表单：
//        step=2  auth=<上面那个>  post_content=<正文>  pid=<回复某楼时带>  post_subject=
//        __inchst=UTF-8  access_uid  access_token
//      空正文会被拒：「内容过短或过长(6~65530 byte) (ERROR: 2048 )」——证明形状是对的。

const REPLY_UA = 'NGA_WP_JW/(;WINDOWS)'

async function postReplyPage({ tid, fid }, auth, body, signal) {
  const form = new URLSearchParams(body || '')
  if (auth && auth.uid) form.set('access_uid', auth.uid)
  if (auth && auth.token) form.set('access_token', auth.token)
  const url = `${BASE}post.php?action=reply&fid=${encodeURIComponent(fid)}&tid=${encodeURIComponent(tid)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': REPLY_UA,
      'X-User-Agent': REPLY_UA,
      Referer: `${BASE}read.php?tid=${tid}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: form.toString(),
    signal,
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let text = buf.toString('utf8')
  if (text.includes('\uFFFD')) {
    try { text = new TextDecoder('gb18030').decode(buf) } catch { /* 保留 utf8 */ }
  }
  return { status: res.status, text, url }
}

/** 从回复页里取那个一次性 auth。 */
export function parseReplyAuth(text) {
  return (String(text).match(/"auth":"([0-9a-fA-F]+)"/) || [])[1] || ''
}

/** 出错页里那句人话（NGA 的报错都是 <div class='error'>…</div>）。 */
function replyErrorText(text) {
  const m = String(text).match(/\(ERROR:\s*\d+\s*\)([^<]{0,200})/)
  if (m) return m[1].trim()
  const t = htmlToText(text).replace(/\s+/g, ' ').trim()
  return t.slice(0, 300)
}

/**
 * 回一帖。auth 是 { uid, token }。
 *   fid  不给就自己从 read.php 里取
 *   pid  给了就是楼中楼（回复某一层）
 * 返回 { ok, message, status }。
 */
export async function replyTopic({ tid, fid, content, pid, subject }, auth, signal) {
  if (!tid) throw new Error('要给 tid')
  if (!auth || !auth.uid || !auth.token) throw new Error('要先登录才能回复')
  const body = String(content ?? '').trim()
  const chars = [...body].length
  const size = Buffer.byteLength(body, 'utf8')
  // 服务端报的是「6~65530 byte」，但实测「你好」（6 字节 / 2 字）会被拒——
  // 所以本地按**字符数**卡 6，宁可严一点。
  if (chars < 6) throw new Error('内容太短：NGA 至少要 6 个字')
  if (size > 65530) throw new Error('内容太长：NGA 上限 65530 字节')

  let useFid = fid ? String(fid) : ''
  if (!useFid) {
    const page = await fetchTopicPage({ tid, page: 1 }, auth, signal)
    useFid = page.fid || ''
  }
  if (!useFid) throw new Error('取不到版面 fid（帖子可能不存在或被锁）')

  const pre = await postReplyPage({ tid, fid: useFid }, auth, '', signal)
  const authCode = parseReplyAuth(pre.text)
  if (!authCode) {
    const why = replyErrorText(pre.text)
    return { ok: false, status: pre.status, message: why || '没拿到回复口令（可能没登录、或这个版不让回）' }
  }

  const payload = new URLSearchParams()
  payload.set('step', '2')
  payload.set('auth', authCode)
  payload.set('post_content', body)
  payload.set('pid', pid ? String(pid) : '')
  payload.set('post_subject', subject ? String(subject) : '')
  payload.set('__inchst', 'UTF-8')

  const out = await postReplyPage({ tid, fid: useFid }, auth, payload.toString(), signal)
  if (/\(ERROR:\s*\d+\s*\)/.test(out.text)) {
    return { ok: false, status: out.status, message: replyErrorText(out.text) }
  }
  if (out.status >= 400) {
    return { ok: false, status: out.status, message: replyErrorText(out.text) || `HTTP ${out.status}` }
  }
  return { ok: true, status: out.status, message: '发出去了', fid: useFid }
}

// ---------- 用户的发帖记录 ----------
// thread.php?authorid=<uid>                → 用户发布的主题
// thread.php?authorid=<uid>&searchpost=1   → 用户发布的帖子（含他的回复）
// 两种页面用的是同一套行：<tr class='rowN topicrow'>，里面有 tid / 标题 / 版面 / 回复数 / 作者 / 时间戳
// 回复列表多一段 .topic_content，里面是那句回复的摘录。

const TZ = 'Asia/Shanghai'

/** unix 秒 → 'YYYY-MM-DD HH:mm'（固定按东八区，跟站上显示一致）。 */
export function fmtNgaTime(sec) {
  if (!sec) return ''
  const d = new Date(Number(sec) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t) => (p.find((x) => x.type === t) || {}).value || ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** 解析「用户发布了什么」那张表。 */
export function parseUserTopics(html) {
  const src = String(html)
  const rows = [...src.matchAll(/<tr[^>]*class=['"][^"']*topicrow[^"']*['"][^>]*>([\s\S]*?)<\/tr>/gi)]
  return rows.map(([, seg]) => {
    const tid = (seg.match(/read\.php\?tid=(\d+)/) || [])[1] || ''
    const title = htmlToText((seg.match(/class=['"]topic['"][^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')
    const forum = htmlToText((seg.match(/class=['"]silver['"][^>]*>(\[[^\]]*\])<\/a>/) || [])[1] || '')
    const repliesRaw = (seg.match(/class=['"]replies['"][^>]*>(\d+)</) || [])[1]
    const uid = (seg.match(/func=ucp&uid=(\d+)/) || [])[1] || ''
    const author = htmlToText((seg.match(/class=['"]author['"][^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')
    const tsRaw = (seg.match(/class=['"]silver postdate['"][^>]*>(\d+)</) || [])[1]
    const snippetRaw = htmlToText((seg.match(/id=['"]postcontent\d+_\d+['"][^>]*>([\s\S]*?)<\/span>/) || [])[1] || '')
    // 摘录里去掉引用的那一段，只留他自己说的话；顺便剥掉色字/加粗这些 UBB 标签
    const snippet = snippetRaw
      .replace(/\[quote\][\s\S]*?\[\/quote\]/gi, '')
      .replace(/\[\/?(?:color|b|i|u|size|font|del|s|table|tr|td|list|\*)[^\]]*\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    const ts = Number(tsRaw || 0)
    return {
      tid,
      title,
      forum,
      replies: repliesRaw ? Number(repliesRaw) : 0,
      uid,
      author,
      time: ts ? ts * 1000 : 0,
      date: fmtNgaTime(ts),
      snippet,
    }
  }).filter((it) => it.tid)
    // NGA 会把「已过期」的位子占成 tid=2/5 这种假行，标题固定是这句，剔掉
    .filter((it) => !(/帖子发布或回复时间超过限制/.test(it.title) && Number(it.tid) < 100))
}

/** 列表里的最大页码。 */
export function parseUserPages(html) {
  let pages = 1
  for (const m of String(html).matchAll(/thread\.php\?authorid=\d+[^'"]*?page=(\d+)/g)) pages = Math.max(pages, Number(m[1]))
  // 「下一页(N)」也能给个下限
  const nx = String(html).match(/下一页\((\d+)\)/)
  if (nx) pages = Math.max(pages, Number(nx[1]))
  return pages
}

/**
 * 看某个人发过什么。
 *   includeReplies = false → 只列他开的主题
 *   includeReplies = true  → 他发的帖子（含回复摘录）
 */
export async function listUserActivity({ uid, page = 1, includeReplies = false }, auth, signal) {
  const id = String(uid || '').trim()
  if (!/^\d+$/.test(id)) throw new Error('uid 要填数字')
  const qs = new URLSearchParams({ authorid: id })
  if (includeReplies) qs.set('searchpost', '1')
  if (Number(page) > 1) qs.set('page', String(page))
  const url = `${BASE}thread.php?${qs.toString()}`
  // 用 GET：POST 过去会被 NGA 挡成一个 ~3KB 的空壳页（状态 200 但没数据，2026-11-01 踩到）。
  // 身份靠浏览器 cookie，token 在这个页面上没用。
  const res = await fetch(url, {
    method: 'GET',
    headers: browserHeaders(`${BASE}thread.php?fid=-7`),
    signal,
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let html = buf.toString('utf8')
  if (html.includes('\uFFFD')) {
    try { html = new TextDecoder('gb18030').decode(buf) } catch { /* 保留 utf8 */ }
  }
  const items = parseUserTopics(html)
  const plain = htmlToText(html)
  return {
    status: res.status,
    bytes: buf.length,
    url,
    uid: id,
    includeReplies: Boolean(includeReplies),
    pages: parseUserPages(html),
    items,
    // 只看 HTTP 状态。以前还判断正文里有没有「未登录」——结果有人发的帖子内容
    // 正好是「未登录」两个字，被误判成没登录（2026-11-01 踩到）。
    needsLogin: res.status === 403,
  }
}

/** 把列表拼成可读文本。 */
export function userActivityToText(res, { page = 1, maxItems = 30 } = {}) {
  const head = `用户 uid ${res.uid} 的${res.includeReplies ? '帖子（含回复）' : '主题'}：第 ${page} 页`
    + `，共 ${res.pages} 页，本页 ${res.items.length} 条`
  const lines = res.items.slice(0, maxItems).map((it, i) => {
    const forum = (it.forum || '?').replace(/^\[/, '').replace(/\]$/, '')
    const bits = [
      `${i + 1}. [${forum}] ${it.title || '(无标题)'}`,
      `tid=${it.tid}`,
      it.replies ? `${it.replies} 回复` : '',
      it.date || '',
    ].filter(Boolean)
    const snip = it.snippet ? `\n   ↳ ${it.snippet.slice(0, 160)}` : ''
    return bits.join('  ') + snip
  })
  return [head, ...lines].join('\n')
}
