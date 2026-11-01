// dsh-nga：读 NGA 帖子的插件（host 半）
//
// **不 import 任何 @deepseek-ai/* 包** —— 插件是 link 装进 profile 的，
// 从插件目录解析不到那些 peer 依赖（实测 MODULE_NOT_FOUND），
// 所以工具直接写成 ctx.tools.register 认的普通对象（见 dsh-nga-reader 的写法）。
//
// 三块：
//   1. 本地路由 /api/nga —— 给设置界面用（status / captcha / login / logout / read）
//   2. 工具 nga_read   —— 给模型用，读帖子
//   3. 工具 nga_captcha —— 给模型用，取一张验证码图（用户看、用户填；我不识别它）
//
// 凭证存进 DSH 内置的 credentials（CredentialRecordStore）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchCaptcha, newRid, passwordLogin, readTopic } from './login.js'

export const name = 'dsh-nga'
export const inject = ['tools', 'credentials', 'webServer']

const CRED_KEY = 'dsh-nga/account'
const CAPTCHA_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'nga-captcha')

async function readCreds(store) {
  let rec
  try { rec = await store.readRecord(CRED_KEY) } catch { rec = undefined }
  if (!rec || typeof rec !== 'object') return null
  const p = rec.payload
  if (!p || typeof p !== 'object' || !p.uid || !p.token) return null
  return { uid: String(p.uid), token: String(p.token) }
}

async function writeCreds(store, creds) {
  await store.modifyRecord(CRED_KEY, async () => ({
    kind: 'grant',
    payload: { version: 1, uid: creds.uid, token: creds.token, at: new Date().toISOString() },
  }))
  return creds
}

async function clearCreds(store) {
  try { await store.deleteRecord(CRED_KEY) } catch { /* 没有就算了 */ }
}

/** 取一张验证码图存到磁盘，返回 { rid, file }。 */
async function saveCaptcha() {
  const rid = newRid()
  const { bytes } = await fetchCaptcha(rid, AbortSignal.timeout(20000))
  fs.mkdirSync(CAPTCHA_DIR, { recursive: true })
  const file = path.join(CAPTCHA_DIR, `captcha-${Date.now()}.png`)
  fs.writeFileSync(file, bytes)
  return { rid, file }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

export function apply(ctx) {
  const store = ctx.credentials

  // ---------- 本地路由（给设置界面用） ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/nga',
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const action = url.searchParams.get('action') || ''
      try {
        if (action === 'status') {
          const creds = await readCreds(store)
          return sendJson(res, 200, { configured: Boolean(creds), uid: creds ? creds.uid : '' })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: '要用 POST' })
        const body = await readBody(req)

        if (action === 'captcha') {
          const { rid, file } = await saveCaptcha()
          const b64 = fs.readFileSync(file).toString('base64')
          return sendJson(res, 200, { rid, image: `data:image/png;base64,${b64}` })
        }

        if (action === 'login') {
          const result = await passwordLogin(
            { name: body.name, password: body.password, rid: body.rid, captcha: body.captcha },
            AbortSignal.timeout(30000),
          )
          if (!result.ok) return sendJson(res, 200, { ok: false, message: result.message })
          await writeCreds(store, result)
          return sendJson(res, 200, { ok: true, uid: result.uid })
        }

        if (action === 'logout') {
          await clearCreds(store)
          return sendJson(res, 200, { ok: true })
        }

        if (action === 'read') {
          const creds = await readCreds(store)
          const out = await readTopic(
            { tid: body.tid, page: body.page, authorId: body.authorId },
            creds,
            AbortSignal.timeout(30000),
          )
          return sendJson(res, 200, { ok: true, ...out })
        }

        return sendJson(res, 404, { error: '不认识的 action: ' + action })
      } catch (error) {
        return sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
      }
    },
  }))

  // ---------- 工具：拿一张验证码图 ----------
  ctx.tools.register({
    name: 'nga_captcha',
    description:
      'Fetch one NGA login captcha image and save it as a local PNG. Return the path so the USER can open it and '
      + 'read the characters. You must NOT try to recognise the characters yourself — ask the user. Keep the '
      + 'returned rid: logging in needs it together with the user-typed code.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute() {
      const { rid, file } = await saveCaptcha()
      return `验证码已生成：${file}\n让用户看图，把上面的字告你。rid=${rid}`
    },
  })

  // ---------- 工具：读帖子 ----------
  ctx.tools.register({
    name: 'nga_read',
    description:
      'Read one NGA (bbs.nga.cn) topic as plain text. Needs a stored account; if it answers that login is '
      + 'needed, ask the user to sign in from Settings → NGA.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tid: { type: 'string', description: 'Topic id (the number in read.php?tid=...)' },
        page: { type: 'integer', description: 'Page number, default 1' },
        authorId: { type: 'string', description: 'Only this author (NGA 的“只看TA”)' },
        maxChars: { type: 'integer', description: 'Truncate the returned text to this many characters (default 8000)' },
      },
      required: ['tid'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const creds = await readCreds(store)
      const out = await readTopic(
        { tid: args.tid, page: args.page || 1, authorId: args.authorId },
        creds,
        AbortSignal.timeout(30000),
      )
      if (out.needsLogin) return '这条要登录才能读。请在「设置 → NGA」里登录一次。'
      const limit = Number(args.maxChars) > 0 ? Number(args.maxChars) : 8000
      return out.text.length > limit ? out.text.slice(0, limit) + '\n…（后面截掉了）' : out.text
    },
  })
}

export default { name, inject, apply }
