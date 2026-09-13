import { expect, test } from 'bun:test'
import { ERR, TaskStore, agentCard, isRpcError, message, parsePeers, parseRpc, parseSend, replyText, sendMessageRequest } from './a2a.ts'

test('agent card: required v1.0 fields, JSONRPC interface, bearer', () => {
  const c = agentCard({ name: 'laptop', description: 'd', url: 'http://10.0.0.1:7500/', version: '0.1.0' })
  expect(c.supportedInterfaces).toEqual([{ url: 'http://10.0.0.1:7500/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
  expect((c.securitySchemes as any).bearer.httpAuthSecurityScheme.scheme).toBe('bearer')
  for (const k of ['name', 'description', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) expect(c).toHaveProperty(k)
})

test('parseRpc', () => {
  expect(parseRpc({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } })).toEqual({ id: 1, method: 'GetTask', params: { id: 'x' } })
  expect((parseRpc({ method: 'x' }) as any).code).toBe(ERR.invalidRequest)
  expect((parseRpc([]) as any).code).toBe(ERR.invalidRequest)
})

test('parseSend: text only, ids carried', () => {
  const ok = parseSend({ message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }, { text: 'there' }], contextId: 'c1', metadata: { from: 'pi' } } })
  expect(isRpcError(ok)).toBe(false)
  if (!isRpcError(ok)) { expect(ok.text).toBe('hi\nthere'); expect(ok.contextId).toBe('c1'); expect(ok.msg.messageId).toBe('m1'); expect(ok.from).toBe('pi') }
  expect((parseSend({ message: { parts: [{ text: 'x' }] } }) as any).from).toBe('peer')
  expect((parseSend({}) as any).code).toBe(ERR.invalidParams)
  expect((parseSend({ message: { parts: [{ url: 'http://x' }] } }) as any).code).toBe(ERR.contentType)
  expect((parseSend({ message: { parts: [{ text: '  ' }] } }) as any).code).toBe(ERR.invalidParams)
})

test('TaskStore: create → wait → finish wakes waiter; timeout returns current state', async () => {
  const s = new TaskStore()
  const t = s.create(message('ROLE_USER', 'q'), 'ctx')
  expect(t.status.state).toBe('TASK_STATE_WORKING')
  expect(s.pending().map(x => x.id)).toEqual([t.id])
  const p = s.wait(t.id, 5000)
  const done = s.finish(t.id, 'TASK_STATE_COMPLETED', 'a')
  expect((await p).status.message?.parts[0]?.text).toBe('a')
  expect(done?.history.map(m => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT'])
  expect(s.finish(t.id, 'TASK_STATE_FAILED')).toBeUndefined()          // already terminal
  const t2 = s.create(message('ROLE_USER', 'slow'), undefined, 'pi')
  expect(t2.metadata?.from).toBe('pi')
  expect((await s.wait(t2.id, 20)).status.state).toBe('TASK_STATE_WORKING')
  expect((s as any).waiters.has(t2.id)).toBe(false)   // timed-out waiter is dropped, not leaked
  await expect(s.wait('nope', 1)).rejects.toThrow('task not found')
})

test('client helpers', () => {
  const r = sendMessageRequest('hello', 'c9')
  expect(r.method).toBe('SendMessage')
  expect(r.params.message.parts).toEqual([{ text: 'hello' }])
  expect(r.params.message.contextId).toBe('c9')
  const peers = parsePeers(' pi = http://10.1.0.2:7500/ , bad, box=https://h:1:trusted ')
  expect([...peers.keys()]).toEqual(['pi', 'box'])
  expect(peers.get('pi')).toEqual({ url: 'http://10.1.0.2:7500', trusted: false, host: '10.1.0.2' })
  expect(peers.get('box')).toEqual({ url: 'https://h:1', trusted: true, host: 'h' })
  expect(replyText({ task: { status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'ans' }] } } } })).toBe('ans')
  expect(replyText({ message: { role: 'ROLE_AGENT', parts: [{ text: 'direct' }] } })).toBe('direct')
  expect(replyText({})).toBe('')
})

import { TaskStore as Store } from './a2a.ts'
import { askPeer, makeHandler } from './peer.ts'

test('endpoint: card public, token gate, SendMessage blocks until reply_peer, GetTask, CancelTask, askPeer round-trip', async () => {
  const store = new Store()
  const inbound: Array<{ id: string; text: string; from: string; ip: string }> = []
  const cfg = { name: 'A', description: 'test', url: 'http://127.0.0.1:0/', version: '0' }
  const srv = Bun.serve({ port: 0, fetch: makeHandler(cfg, store, { token: 'secret', waitMs: 3000, onInbound: (t, text, from, ip) => inbound.push({ id: t.id, text, from, ip }), remoteIp: () => '127.0.0.1' }) })
  const base = `http://127.0.0.1:${srv.port}`
  try {
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json()
    expect(card.name).toBe('A')
    expect((await fetch(base, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(base, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401)

    // Ask from a "client" while the "session" answers after 100 ms.
    setTimeout(() => store.finish(inbound[0]!.id, 'TASK_STATE_COMPLETED', 'forty-two'), 100)
    const r = await askPeer(`${base}/`, 'secret', 'meaning?', 'ctx1', 3000, 'laptop')
    expect(r.text).toBe('forty-two')
    expect(inbound[0]!.text).toBe('meaning?')
    expect(inbound[0]!.from).toBe('laptop')
    expect(inbound[0]!.ip).toBe('127.0.0.1')
    expect(r.contextId).toBe('ctx1')

    const post = (m: unknown) => fetch(base, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(m) })
    const got = await (await post({ jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: r.taskId } })).json()
    expect(got.result.status.state).toBe('TASK_STATE_COMPLETED')
    expect((await (await post({ jsonrpc: '2.0', id: 8, method: 'GetTask', params: { id: 'nope' } })).json()).error.code).toBe(-32001)

    // Non-blocking send, then cancel.
    const nb = await (await post({ jsonrpc: '2.0', id: 9, method: 'SendMessage', params: { message: { role: 'ROLE_USER', parts: [{ text: 'later' }] }, configuration: { returnImmediately: true } } })).json()
    expect(nb.result.task.status.state).toBe('TASK_STATE_WORKING')
    const c = await (await post({ jsonrpc: '2.0', id: 10, method: 'CancelTask', params: { id: nb.result.task.id } })).json()
    expect(c.result.status.state).toBe('TASK_STATE_CANCELED')
    expect((await (await post({ jsonrpc: '2.0', id: 11, method: 'Nope' })).json()).error.code).toBe(-32601)
    expect((await post({ jsonrpc: '2.0', id: 12, method: 'SendMessage', params: { message: { parts: [{ url: 'x' }] } } })).status).toBe(400)
    expect((await fetch(base, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{"pad":"' + 'x'.repeat(70_000) + '"}' })).status).toBe(413)

    // Blocking send that nobody answers → returns the working task after waitMs; askPeer reports it.
    const s2 = Bun.serve({ port: 0, fetch: makeHandler(cfg, new Store(), { token: 't', waitMs: 50, onInbound: () => {} }) })
    await expect(askPeer(`http://127.0.0.1:${s2.port}/`, 't', 'q', undefined, 3000)).rejects.toThrow('still working')
    s2.stop(true)
  } finally { srv.stop(true) }
})
