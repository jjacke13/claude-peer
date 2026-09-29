import { expect, test } from 'bun:test'
import { replyText } from './a2a.ts'
import { askPeer } from './peer.ts'

// A hermes-like peer: advertises streaming, IGNORES returnImmediately (a blocking SendMessage
// never returns in time), streams the task id at once + keepalives, answers via GetTask.
function fakeStreamingPeer(opts: { answerAfterMs: number; dropStreamEarly?: boolean; answerIn?: 'status' | 'artifact' }) {
  const t0 = Date.now()
  const taskId = 'task-stream-1'
  const answered = () => Date.now() - t0 >= opts.answerAfterMs
  const task = () => {
    const done = answered()
    const t: any = { id: taskId, contextId: 'ctx-s', status: { state: done ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' } }
    if (done && opts.answerIn === 'artifact') t.artifacts = [{ artifactId: 'a1', parts: [{ text: 'artifact answer' }] }]
    else if (done) t.status.message = { role: 'ROLE_AGENT', messageId: 'm', parts: [{ text: 'streamed answer' }] }
    return t
  }
  const calls: string[] = []
  const srv = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      if (req.method === 'GET') return Response.json({ name: 'fake', capabilities: { streaming: true } })
      const rpc: any = await req.json()
      calls.push(rpc.method)
      if (rpc.method === 'SendMessage') { await Bun.sleep(20_000); return Response.json({}) }   // hermes: blocks for the whole job
      if (rpc.method === 'GetTask') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: task() })
      // SendStreamingMessage
      const enc = new TextEncoder()
      const ev = (result: unknown) => enc.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`)
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(ev({ task: { id: taskId, contextId: 'ctx-s', status: { state: 'TASK_STATE_SUBMITTED' } } }))
          if (opts.dropStreamEarly) { c.close(); return }
          c.enqueue(ev({ statusUpdate: { taskId, contextId: 'ctx-s', status: { state: 'TASK_STATE_WORKING' } } }))
          while (!answered()) { c.enqueue(enc.encode(': keepalive\n\n')); await Bun.sleep(40) }
          c.enqueue(ev({ statusUpdate: { taskId, contextId: 'ctx-s', status: { state: 'TASK_STATE_COMPLETED' } } }))
          c.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { srv, calls, url: `http://127.0.0.1:${srv.port}/` }
}

test('askPeer streams from a peer that ignores returnImmediately (hermes)', async () => {
  const p = fakeStreamingPeer({ answerAfterMs: 400 })
  try {
    const polled: string[] = []
    const r = await askPeer(p.url, 't', 'long job', undefined, 5000, 'laptop', 50, id => polled.push(id))
    expect(r.text).toBe('streamed answer')
    expect(r.taskId).toBe('task-stream-1')
    expect(p.calls).not.toContain('SendMessage')          // never the blocking call
    expect(p.calls).toContain('SendStreamingMessage')
    expect(polled.length).toBeGreaterThan(0)               // keepalives drive progress
  } finally { p.srv.stop(true) }
})

test('askPeer falls back to GetTask polling when the stream drops after the task id', async () => {
  const p = fakeStreamingPeer({ answerAfterMs: 300, dropStreamEarly: true, answerIn: 'artifact' })
  try {
    const r = await askPeer(p.url, 't', 'long job', undefined, 5000, 'laptop', 50)
    expect(r.text).toBe('artifact answer')
    expect(p.calls.filter(c => c === 'GetTask').length).toBeGreaterThan(1)
  } finally { p.srv.stop(true) }
})

test('askPeer over streaming still gives up at the deadline', async () => {
  const p = fakeStreamingPeer({ answerAfterMs: 60_000 })
  try {
    await expect(askPeer(p.url, 't', 'never', undefined, 400, 'laptop', 50)).rejects.toThrow(/still working/)
  } finally { p.srv.stop(true) }
})

test('replyText reads artifacts when there is no status message', () => {
  expect(replyText({ task: { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'a' }, { text: 'b' }] }] } })).toBe('a\nb')
})
