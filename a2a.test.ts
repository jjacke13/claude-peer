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
  const ok = parseSend({ message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }, { text: 'there' }], contextId: 'c1' } })
  expect(isRpcError(ok)).toBe(false)
  if (!isRpcError(ok)) { expect(ok.text).toBe('hi\nthere'); expect(ok.contextId).toBe('c1'); expect(ok.msg.messageId).toBe('m1') }
  expect((parseSend({}) as any).code).toBe(ERR.invalidParams)
  expect((parseSend({ message: { parts: [{ url: 'http://x' }] } }) as any).code).toBe(ERR.unsupported)
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
  const t2 = s.create(message('ROLE_USER', 'slow'))
  expect((await s.wait(t2.id, 20)).status.state).toBe('TASK_STATE_WORKING')
  await expect(s.wait('nope', 1)).rejects.toThrow('task not found')
})

test('client helpers', () => {
  const r = sendMessageRequest('hello', 'c9')
  expect(r.method).toBe('SendMessage')
  expect(r.params.message.parts).toEqual([{ text: 'hello' }])
  expect(r.params.message.contextId).toBe('c9')
  expect(parsePeers(' pi = http://10.1.0.2:7500/ , bad, box=https://h:1 ')).toEqual(new Map([['pi', 'http://10.1.0.2:7500'], ['box', 'https://h:1']]))
  expect(replyText({ task: { status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'ans' }] } } } })).toBe('ans')
  expect(replyText({ message: { role: 'ROLE_AGENT', parts: [{ text: 'direct' }] } })).toBe('direct')
  expect(replyText({})).toBe('')
})
