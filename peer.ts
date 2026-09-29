// The A2A HTTP endpoint as a plain fetch handler (Bun.serve-compatible) plus the outbound
// client. Pure enough to unit-test: I/O is injected via `hooks`. server.ts binds it to the
// nospoon address and wires the MCP side.
import { A2A_VERSION, CARD_PATH, ERR, MAX_BODY, TaskStore, agentCard, isRpcError, parseRpc, parseSend, replyText, rpcError, rpcResult, sendMessageRequest, streamMessageRequest, getTaskRequest, type PeerConfig, type Task } from './a2a.ts'
import { timingSafeEqual } from 'crypto'

export type Hooks = {
  token: string                                   // shared bearer secret (required)
  onInbound: (task: Task, text: string, from: string, remoteIp: string) => void   // deliver into the session
  remoteIp?: (req: Request) => string                                            // Bun: server.requestIP(req)
  waitMs: number                                  // how long SendMessage blocks for a reply
  log?: (line: string) => void
}

// Constant-time compare; lengths differ → compare against itself so timing stays flat.
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function makeHandler(cfg: PeerConfig, store: TaskStore, hooks: Hooks) {
  const log = hooks.log ?? (() => {})
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'A2A-Version': A2A_VERSION } })

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === CARD_PATH) return json(200, agentCard(cfg))   // card is public by spec

    // Everything else is the JSON-RPC endpoint and needs the bearer token. Wrong/missing token
    // gets the same 401 either way — nothing to enumerate.
    if (!sameSecret(req.headers.get('authorization') ?? '', `Bearer ${hooks.token}`)) return json(401, rpcError(null, ERR.unauthorized, 'unauthorized'))
    if (req.method !== 'POST') return json(405, rpcError(null, ERR.invalidRequest, 'POST JSON-RPC here'))
    const ver = req.headers.get('a2a-version')
    if (ver && ver !== A2A_VERSION && ver !== '0.3') return json(400, rpcError(null, ERR.versionNotSupported, `A2A-Version ${ver} not supported`))

    const len = Number(req.headers.get('content-length') ?? 0)
    if (len > MAX_BODY) return json(413, rpcError(null, ERR.invalidRequest, `body larger than ${MAX_BODY} bytes`))
    let body: unknown
    try {
      const raw = await req.text()
      if (raw.length > MAX_BODY) return json(413, rpcError(null, ERR.invalidRequest, `body larger than ${MAX_BODY} bytes`))
      body = JSON.parse(raw)
    } catch { return json(400, rpcError(null, ERR.parse, 'invalid JSON')) }
    const rpc = parseRpc(body)
    if (isRpcError(rpc)) return json(400, rpcError(null, rpc.code, rpc.message))

    switch (rpc.method) {
      case 'SendMessage': {
        const s = parseSend(rpc.params)
        if (isRpcError(s)) return json(400, rpcError(rpc.id, s.code, s.message))
        if (s.taskId) return json(400, rpcError(rpc.id, ERR.unsupported, 'follow-up messages on an existing task are not supported; send a new message with the same contextId'))
        const task = store.create(s.msg, s.contextId, s.from)
        log(`inbound task ${task.id.slice(0, 8)} from ${s.from}: "${s.text.slice(0, 60)}"`)
        try { hooks.onInbound(task, s.text, s.from, hooks.remoteIp?.(req) ?? '') } catch (e) { log(`delivery failed: ${e}`); store.finish(task.id, 'TASK_STATE_FAILED'); return json(500, rpcError(rpc.id, ERR.internal, 'delivery failed')) }
        const done = rpc.params?.configuration?.returnImmediately ? task : await store.wait(task.id, hooks.waitMs)
        return json(200, rpcResult(rpc.id, { task: done }))
      }
      case 'GetTask': {
        const t = store.get(String(rpc.params?.id ?? ''))
        return t ? json(200, rpcResult(rpc.id, t)) : json(404, rpcError(rpc.id, ERR.taskNotFound, 'Task not found'))
      }
      case 'CancelTask': {
        const id = String(rpc.params?.id ?? '')
        if (!store.get(id)) return json(404, rpcError(rpc.id, ERR.taskNotFound, 'Task not found'))
        const t = store.finish(id, 'TASK_STATE_CANCELED')
        return t ? json(200, rpcResult(rpc.id, t)) : json(400, rpcError(rpc.id, ERR.taskNotCancelable, 'task already finished'))
      }
      default:
        return json(404, rpcError(rpc.id, ERR.methodNotFound, `${rpc.method} not supported`))
    }
  }
}

const WORKING = ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']

// Does the peer's agent card advertise streaming? Cached per URL; any failure means "no",
// which keeps the old blocking-then-poll path for peers without a card or without streaming.
const streamingCache = new Map<string, boolean>()
async function supportsStreaming(url: string): Promise<boolean> {
  const hit = streamingCache.get(url)
  if (hit !== undefined) return hit
  let yes = false
  try {
    const res = await fetch(new URL(CARD_PATH, url), { signal: AbortSignal.timeout(5_000) })
    yes = res.ok && (await res.json())?.capabilities?.streaming === true
  } catch { /* no card → not streaming */ }
  streamingCache.set(url, yes)
  return yes
}

// Send over SSE and return the task id once the task finishes — or as soon as the stream
// breaks, if we already have the id (the caller then polls GetTask). Every line received,
// keepalives included, counts as progress.
async function streamUntilDone(url: string, headers: Record<string, string>, req: unknown, deadline: number, onPoll?: (taskId: string) => void): Promise<string> {
  let taskId: string | undefined
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    if (!res.ok || !res.body) throw new Error(`peer HTTP ${res.status}`)
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const body: any = await res.json().catch(() => ({}))
      if (body?.error) throw new PeerRpcError(body.error)
      const id = body?.result?.task?.id
      if (!id) throw new Error('peer answered the stream request without a task')
      return id
    }
    const lines = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await lines.read()
      if (done) break
      buf += value
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (taskId) onPoll?.(taskId)
        if (!line.startsWith('data:')) continue
        let ev: any
        try { ev = JSON.parse(line.slice(5)) } catch { continue }
        if (ev?.error) throw new PeerRpcError(ev.error)
        const r = ev?.result ?? {}
        taskId = r.task?.id ?? r.statusUpdate?.taskId ?? r.artifactUpdate?.taskId ?? taskId
        const state = r.task?.status?.state ?? r.statusUpdate?.status?.state
        if (taskId && state && !WORKING.includes(state)) { lines.cancel().catch(() => {}); return taskId }
      }
    }
  } catch (e) {
    if (e instanceof PeerRpcError || !taskId) throw e   // nothing to poll, or the peer said no
  }
  if (!taskId) throw new Error('peer stream ended without a task id')
  return taskId   // stream ended or broke mid-task: the caller polls GetTask
}

class PeerRpcError extends Error {
  constructor(e: { code?: number; message?: string }) { super(`peer error ${e.code}: ${e.message}`) }
}

// Ask a peer and return its reply text. SendMessage blocks for the peer's window (BLOCK_MS at
// most — Bun's fetch gives up at 5 min and Bun.serve at 255 s idle); a task still WORKING after
// that is polled with GetTask every POLL_MS until it completes or timeoutMs runs out.
export const BLOCK_MS = 120_000
const POLL_MS = 5_000
export async function askPeer(url: string, token: string, text: string, contextId: string | undefined, timeoutMs: number, from?: string, pollMs = POLL_MS, onPoll?: (taskId: string) => void): Promise<{ text: string; contextId?: string; taskId?: string }> {
  const deadline = Date.now() + timeoutMs
  const post = async (req: unknown, ms: number): Promise<any> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'A2A-Version': A2A_VERSION },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(ms),
    })
    const body: any = await res.json().catch(() => ({}))
    if (body?.error) throw new Error(`peer error ${body.error.code}: ${body.error.message}`)
    if (!res.ok) throw new Error(`peer HTTP ${res.status}`)
    return body?.result ?? {}
  }
  // Streaming peers: take the task id from the stream, then read the result with GetTask.
  // A blocking SendMessage to a peer that ignores returnImmediately would outlive our fetch
  // and lose the task id (hermes, found live 2026-09-29: "The operation timed out.").
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'A2A-Version': A2A_VERSION }
  let r: any
  if (await supportsStreaming(url)) {
    const taskId = await streamUntilDone(url, headers, streamMessageRequest(text, contextId, from), deadline, onPoll)
    r = { task: await post(getTaskRequest(taskId), 30_000) }
  } else {
    r = await post(sendMessageRequest(text, contextId, from), Math.min(BLOCK_MS, timeoutMs) + 10_000)
  }
  while (WORKING.includes(r?.task?.status?.state)) {
    if (Date.now() > deadline) throw new Error(`peer did not answer within ${Math.round(timeoutMs / 1000)} s (task ${r.task.id} still working)`)
    await Bun.sleep(pollMs)
    onPoll?.(r.task.id)
    r = { task: await post(getTaskRequest(r.task.id), 30_000) }   // GetTask returns the Task itself
  }
  const t = replyText(r)
  if (!t) throw new Error(`empty reply (${r?.task?.status?.state ?? 'no task'})`)
  return { text: t, contextId: r?.task?.contextId ?? r?.message?.contextId, taskId: r?.task?.id }
}
