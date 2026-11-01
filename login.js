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

const BASE = 'https://bbs.nga.cn/'
const NUKE = BASE + 'nuke.php'
const READ_UA = 'NGA_WP_JW/(;WINDOWS)'
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

/** 读一个帖子。auth 是 { uid, token }。 */
export async function readTopic({ tid, page = 1, authorId }, auth, signal) {
  if (!tid) throw new Error('要给 tid')
  const qs = new URLSearchParams({ tid: String(tid) })
  if (Number(page) > 1) qs.set('page', String(page))
  if (authorId) qs.set('authorid', String(authorId))
  const url = `${BASE}read.php?${qs.toString()}`
  const form = new URLSearchParams()
  if (auth && auth.uid) form.set('access_uid', auth.uid)
  if (auth && auth.token) form.set('access_token', auth.token)
  const headers = { 'User-Agent': READ_UA, 'X-User-Agent': READ_UA, Referer: `${BASE}/`, 'Content-Type': 'application/x-www-form-urlencoded' }
  const res = await fetch(url, { method: 'POST', headers, body: form.toString(), signal })
  const buf = Buffer.from(await res.arrayBuffer())
  let html = buf.toString('utf8')
  if (html.includes('\uFFFD')) {
    try { html = new TextDecoder('gb18030').decode(buf) } catch { /* 保留 utf8 */ }
  }
  const text = htmlToText(html)
  return { status: res.status, bytes: buf.length, text, url, needsLogin: res.status === 403 || /未登录/.test(text) }
}
