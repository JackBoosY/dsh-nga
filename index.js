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
import { fetchCaptcha, listUserActivity, newRid, passwordLogin, patrolOnce, readTopic, replyTopic, userActivityToText } from './login.js'

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

  // 巡检只允许同时跑一轮；状态挂在内存里，前端轮询它
  let patrolJob = null

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
            { tid: body.tid, page: body.page, pages: body.pages, authorId: body.authorId, authorOnly: Boolean(body.authorOnly) },
            creds,
            AbortSignal.timeout(45000),
          )
          return sendJson(res, 200, { ok: true, ...out })
        }

        // 一轮巡检：第一页帖子 → 查楼主发帖记录 → 判定 → （可选）回复
        // 跑在后台：立刻回 jobId，前端轮询 patrolStatus 看进度，patrolCancel 能叫停。
        if (action === 'patrol') {
          const creds = await readCreds(store)
          if (!creds) return sendJson(res, 200, { ok: false, error: '还没登录' })
          if (patrolJob && patrolJob.state.running) {
            return sendJson(res, 200, { ok: false, error: '上一轮还在跑，先等它结束或者取消' })
          }
          const q = (k, d) => {
            const v = url.searchParams.get(k)
            if (v != null && v !== '') return v
            const b = body[k]
            return b != null && b !== '' ? b : d
          }
          const job = {
            aborted: false,
            state: {
              running: true, fid: '-7', page: 1, dryRun: true,
              checked: 0, totalOperators: 0, candidates: 0, posted: 0,
              results: [], startedAt: Date.now(), error: '',
            },
          }
          patrolJob = job
          const opts = {
            fid: String(q('fid', '-7')),
            page: Number(q('page', 1)) > 0 ? Number(q('page', 1)) : 1,
            maxUsers: Number(q('maxUsers', 12)) > 0 ? Number(q('maxUsers', 12)) : 12,
            dryRun: String(q('dryRun', 'true')) !== 'false',
            text: String(q('text', '') || '').trim() || undefined,
            shouldStop: () => job.aborted,
            onProgress: (snap) => { job.state = { ...job.state, ...snap, running: true } },
          }
          job.state.dryRun = opts.dryRun
          patrolOnce(opts, creds, AbortSignal.timeout(600000))
            .then((out) => { job.state = { ...job.state, ...out, running: false } })
            .catch((e) => { job.state = { ...job.state, running: false, error: e && e.message ? e.message : String(e) } })
          return sendJson(res, 200, { ok: true, jobId: 'current', dryRun: opts.dryRun, maxUsers: opts.maxUsers })
        }

        if (action === 'patrolStatus') {
          if (!patrolJob) return sendJson(res, 200, { ok: true, running: false, empty: true })
          return sendJson(res, 200, { ok: true, ...patrolJob.state })
        }

        if (action === 'patrolCancel') {
          if (!patrolJob || !patrolJob.state.running) return sendJson(res, 200, { ok: true, cancelled: false, message: '没有在跑的' })
          patrolJob.aborted = true
          return sendJson(res, 200, { ok: true, cancelled: true })
        }

        // 第二步：报告看过了、人来点「就发这几条」，才真发。
        // 必须显式 confirm，且只接受 tids 列表 —— 不再由巡检自己直接发。
        if (action === 'patrolSend') {
          const creds = await readCreds(store)
          if (!creds) return sendJson(res, 200, { ok: false, error: '还没登录' })
          if (body.confirm !== true) return sendJson(res, 200, { ok: false, error: '要显式 confirm' })
          const tids = Array.isArray(body.tids) ? body.tids.map(String).filter((t) => /^\d+$/.test(t)).slice(0, 5) : []
          if (!tids.length) return sendJson(res, 200, { ok: false, error: '没给 tids' })
          const content = typeof body.text === 'string' && body.text.trim()
            ? body.text.trim()
            : '提示：此账号只发主题、无任何回复记录'
          const out = []
          for (const tid of tids) {
            try {
              const r = await replyTopic({ tid, fid: body.fid || '-7', content }, creds, AbortSignal.timeout(45000))
              out.push({ tid, ok: r.ok, message: r.message })
            } catch (e) {
              out.push({ tid, ok: false, message: e && e.message ? e.message : String(e) })
            }
            await new Promise((r) => setTimeout(r, 1200))
          }
          return sendJson(res, 200, { ok: true, results: out, posted: out.filter((x) => x.ok).length })
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
      'Read one NGA (bbs.nga.cn) topic as plain text, floor by floor (who / when / what). Can read several pages at '
      + 'once and can read only the topic starter (只看楼主). Needs a stored account; if it answers that login is '
      + 'needed, ask the user to sign in from Settings → NGA.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tid: { type: 'string', description: 'Topic id (the number in read.php?tid=...)' },
        page: { type: 'integer', description: 'Single page number, default 1 (ignored when pages is given)' },
        pages: { type: 'string', description: 'Several pages: "2" or "1-3". At most 5 pages per call.' },
        authorOnly: { type: 'boolean', description: 'Only the topic starter (NGA 的“只看楼主”)' },
        authorId: { type: 'string', description: 'Only this author uid (NGA 的“只看TA”)' },
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
        {
          tid: args.tid,
          page: args.page || 1,
          pages: args.pages,
          authorId: args.authorId,
          authorOnly: Boolean(args.authorOnly),
        },
        creds,
        AbortSignal.timeout(45000),
      )
      if (out.needsLogin) return '这条要登录才能读。请在「设置 → NGA」里登录一次。'
      const head = [
        out.title ? `标题：${out.title}` : '',
        out.forum ? `版面：${out.forum}` : '',
        out.authorId ? `只看：uid ${out.authorId}` : '',
        out.floors && out.floors.length ? `共 ${out.floors.length} 层` : '',
      ].filter(Boolean).join('\n')
      const body = head ? `${head}\n\n${out.text}` : out.text
      const limit = Number(args.maxChars) > 0 ? Number(args.maxChars) : 8000
      return body.length > limit ? body.slice(0, limit) + '\n…（后面截掉了）' : body
    },
  })

  // ---------- 工具：回帖 ----------
  // 这是往主人的 NGA 账号上发公开内容，所以有硬闸：必须显式传 confirm: true。
  ctx.tools.register({
    name: 'nga_reply',
    description:
      'Post a reply to an NGA (bbs.nga.cn) topic using the signed-in account. THE REPLY IS PUBLIC AND PERMANENT — '
      + 'it appears under the user\'s name for everyone. Never call this without the user explicitly asking for that '
      + 'exact reply. The call must carry confirm: true; without it the tool refuses. Keep the text short and human.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tid: { type: 'string', description: 'Topic id (the number in read.php?tid=...)' },
        content: { type: 'string', description: 'Reply body. NGA wants 6–65530 bytes; keep it short.' },
        fid: { type: 'string', description: 'Board id. Omit to look it up from the topic page.' },
        pid: { type: 'string', description: 'Reply to that floor instead of the whole thread (楼中楼)' },
        confirm: { type: 'boolean', description: 'Must be true. Confirms the user asked for this exact public reply.' },
      },
      required: ['tid', 'content'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      if (args.confirm !== true) {
        return '没发。这个工具会往主人的账号上发公开内容，必须显式传 confirm: true；'
          + '而且要先确认主人真的要发这一条。'
      }
      const creds = await readCreds(store)
      if (!creds) return '没登录，发不了。请在「设置 → NGA」里登录一次。'
      const out = await replyTopic(
        { tid: args.tid, fid: args.fid, content: args.content, pid: args.pid },
        creds,
        AbortSignal.timeout(45000),
      )
      return out.ok
        ? `发出去了（HTTP ${out.status}${out.fid ? `，fid ${out.fid}` : ''}）。`
        : `没发成：${out.message}`
    },
  })

  // ---------- 工具：看某个用户发过什么 ----------
  ctx.tools.register({
    name: 'nga_user',
    description:
      'List what a user has posted on NGA (bbs.nga.cn): either the topics they started, or every post including '
      + 'replies (with a snippet of what they wrote). Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uid: { type: 'string', description: 'NGA user id (number). Use "me" for the signed-in account.' },
        includeReplies: { type: 'boolean', description: 'true = every post including replies; false/omitted = topics only' },
        page: { type: 'integer', description: 'Page number, default 1' },
        maxItems: { type: 'integer', description: 'Max rows to show, default 30' },
      },
      required: ['uid'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const creds = await readCreds(store)
      let uid = String(args.uid || '').trim()
      if (uid === 'me') {
        if (!creds) return '还没登录，没法用 "me"。请在「设置 → NGA」里登录，或直接给 uid。'
        uid = creds.uid
      }
      const page = Number(args.page) > 0 ? Number(args.page) : 1
      const out = await listUserActivity(
        { uid, page, includeReplies: Boolean(args.includeReplies) },
        creds,
        AbortSignal.timeout(45000),
      )
      if (out.needsLogin) return '这个要登录才能看。请在「设置 → NGA」里登录一次。'
      if (!out.items.length) return `uid ${out.uid} 这一页没有内容（可能没有权限看，或者这就是空的）。`
      const maxItems = Number(args.maxItems) > 0 ? Number(args.maxItems) : 30
      const body = userActivityToText(out, { page, maxItems })
      return out.pages > page ? `${body}\n（还有第 ${page + 1} 页）` : body
    },
  })
}

export default { name, inject, apply }
