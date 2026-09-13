// A2A v1.0 (Linux Foundation) — the JSON-RPC binding subset this plugin speaks, as pure
// functions: Agent Card, request parsing/validation, Task objects, an in-memory task store,
// and the client-side request builder. Field names follow ProtoJSON (lowerCamelCase, enums as
// strings) per specification/a2a.proto. No I/O here; server.ts does HTTP + MCP.

export const A2A_VERSION = '1.0'
export const CARD_PATH = '/.well-known/agent-card.json'
export const MAX_TEXT = 20_000            // chars per inbound message — it lands in a live session's context
export const MAX_BODY = 64 * 1024          // bytes per HTTP body
export const PEER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

// JSON-RPC error codes: standard + A2A-specific (spec §5.4).
export const ERR = {
  parse: -32700, invalidRequest: -32600, unauthorized: -32010, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  taskNotFound: -32001, taskNotCancelable: -32002, unsupported: -32004, contentType: -32005, versionNotSupported: -32009,
} as const

export type Part = { text: string }
export type Message = { messageId: string; role: 'ROLE_USER' | 'ROLE_AGENT'; parts: Part[]; contextId?: string; taskId?: string }
export type TaskState = 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED'
export type Task = { id: string; contextId: string; status: { state: TaskState; message?: Message; timestamp: string }; history: Message[]; metadata?: { from?: string } }

export type PeerConfig = { name: string; description: string; url: string; version: string }

export function agentCard(c: PeerConfig): Record<string, unknown> {
  return {
    name: c.name,
    description: c.description,
    version: c.version,
    supportedInterfaces: [{ url: c.url, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer', description: 'shared PEER_TOKEN' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'chat', name: 'Ask this Claude Code session', tags: ['chat', 'claude-code'],
      description: 'Send a question or task as text; the live session answers when its turn completes.',
      inputModes: ['text/plain'], outputModes: ['text/plain'],
    }],
  }
}

export const newId = () => crypto.randomUUID()
export const textOf = (m: Message | undefined) => (m?.parts ?? []).map(p => p.text ?? '').filter(Boolean).join('\n')

export function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { messageId: newId(), role, parts: [{ text }], ...extra }
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────────────────
export type Rpc = { id: string | number | null; method: string; params: any }
export type RpcError = { code: number; message: string }

export function parseRpc(body: unknown): Rpc | RpcError {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { code: ERR.invalidRequest, message: 'expected a JSON-RPC 2.0 object' }
  const b = body as Record<string, unknown>
  if (b.jsonrpc !== '2.0' || typeof b.method !== 'string') return { code: ERR.invalidRequest, message: 'jsonrpc must be "2.0" and method a string' }
  const id = typeof b.id === 'string' || typeof b.id === 'number' ? b.id : null
  return { id, method: b.method, params: b.params ?? {} }
}
export const isRpcError = (x: Rpc | RpcError): x is RpcError => 'code' in x

export const rpcResult = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
export const rpcError = (id: Rpc['id'], code: number, msg: string) => ({ jsonrpc: '2.0', id, error: { code, message: msg } })

// SendMessage params → the text and ids we act on. Only text parts are accepted.
export function parseSend(params: any): { text: string; msg: Message; contextId?: string; taskId?: string; from: string } | RpcError {
  const m = params?.message
  if (!m || typeof m !== 'object') return { code: ERR.invalidParams, message: 'params.message required' }
  if (!Array.isArray(m.parts) || !m.parts.length) return { code: ERR.invalidParams, message: 'message.parts required' }
  if (m.parts.some((p: any) => typeof p?.text !== 'string')) return { code: ERR.contentType, message: 'only text parts are supported' }
  const text = m.parts.map((p: any) => p.text).join('\n').trim()
  if (!text) return { code: ERR.invalidParams, message: 'empty message' }
  if (text.length > MAX_TEXT) return { code: ERR.invalidParams, message: `message longer than ${MAX_TEXT} chars` }
  const msg: Message = { messageId: String(m.messageId || newId()), role: 'ROLE_USER', parts: m.parts.map((p: any) => ({ text: p.text })) }
  // Sender name travels in Message.metadata (a Struct per spec). With a shared token it is a
  // claim, not proof — fine inside a private network; per-peer tokens are v2.
  const from = typeof m.metadata?.from === 'string' && PEER_NAME_RE.test(m.metadata.from) ? m.metadata.from : 'peer'
  return { text, msg, contextId: typeof m.contextId === 'string' ? m.contextId : undefined, taskId: typeof m.taskId === 'string' ? m.taskId : undefined, from }
}

// ── tasks ───────────────────────────────────────────────────────────────────────────────
const TERMINAL: TaskState[] = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']

// In-memory: one process = one session; tasks do not outlive it (spec allows any persistence).
export class TaskStore {
  private tasks = new Map<string, Task>()
  private waiters = new Map<string, Array<(t: Task) => void>>()
  constructor(private max = 200) {}

  create(userMsg: Message, contextId?: string, from?: string): Task {
    const id = newId()
    const t: Task = { id, contextId: contextId ?? newId(), status: { state: 'TASK_STATE_WORKING', timestamp: now() }, history: [{ ...userMsg, taskId: id }], ...(from ? { metadata: { from } } : {}) }
    this.tasks.set(id, t)
    if (this.tasks.size > this.max) { const old = this.tasks.keys().next().value!; this.tasks.delete(old); this.waiters.delete(old) }   // drop oldest
    return t
  }
  get(id: string): Task | undefined { return this.tasks.get(id) }
  pending(): Task[] { return [...this.tasks.values()].filter(t => !TERMINAL.includes(t.status.state)) }

  // Terminal transition; wakes blocked SendMessage callers.
  finish(id: string, state: TaskState, text?: string): Task | undefined {
    const t = this.tasks.get(id)
    if (!t || TERMINAL.includes(t.status.state)) return undefined
    const msg = text ? message('ROLE_AGENT', text, { taskId: id, contextId: t.contextId }) : undefined
    const done: Task = { ...t, status: { state, message: msg, timestamp: now() }, history: msg ? [...t.history, msg] : t.history }
    this.tasks.set(id, done)
    for (const w of this.waiters.get(id) ?? []) w(done)
    this.waiters.delete(id)
    return done
  }

  // Resolve when the task reaches a terminal state, or with its current state after timeoutMs.
  wait(id: string, timeoutMs: number): Promise<Task> {
    const t = this.tasks.get(id)
    if (!t) return Promise.reject(new Error('task not found'))
    if (TERMINAL.includes(t.status.state)) return Promise.resolve(t)
    return new Promise(resolve => {
      const w = (done: Task) => { clearTimeout(timer); resolve(done) }
      const timer = setTimeout(() => { this.drop(id, w); resolve(this.tasks.get(id)!) }, timeoutMs)
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), w])
    })
  }
  private drop(id: string, fn: (t: Task) => void) {
    const left = (this.waiters.get(id) ?? []).filter(w => w !== fn)
    if (left.length) this.waiters.set(id, left); else this.waiters.delete(id)
  }
}
const now = () => new Date().toISOString()

// ── client side ─────────────────────────────────────────────────────────────────────────
export function sendMessageRequest(text: string, contextId?: string, from?: string) {
  const msg: any = message('ROLE_USER', text, contextId ? { contextId } : {})
  if (from) msg.metadata = { from }
  return { jsonrpc: '2.0', id: newId(), method: 'SendMessage', params: { message: msg, configuration: { returnImmediately: false } } }
}

// Peers: "name=http://host:port[:trusted], …" (COMMA-separated; names [A-Za-z0-9_-]).
// trusted = that peer may assign us tasks, not only ask questions (see README "Trust levels").
export type Peer = { url: string; trusted: boolean; host: string; local?: boolean }   // local = this machine's registry
export function parsePeers(raw: string | undefined): Map<string, Peer> {
  const out = new Map<string, Peer>()
  for (const item of (raw ?? '').split(',')) {
    const m = item.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*(https?:\/\/[^\s:]+(?::\d+)?\/?)(?::(trusted))?$/)
    if (!m) continue
    const url = m[2]!.replace(/\/+$/, '')
    out.set(m[1]!, { url, trusted: m[3] === 'trusted', host: new URL(url).hostname })
  }
  return out
}

// Reply text out of a SendMessage result ({task} or {message}).
export function replyText(result: any): string {
  if (result?.message) return textOf(result.message)
  const t = result?.task
  if (!t) return ''
  return textOf(t.status?.message) || textOf([...(t.history ?? [])].reverse().find((m: Message) => m.role === 'ROLE_AGENT'))
}
