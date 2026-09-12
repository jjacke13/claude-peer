// bun smoke.ts — two stdio servers on loopback driven over JSON-RPC: ask → channel → reply → answer.
// Two MCP stdio servers A (7601) and B (7602) on loopback; drive them over JSON-RPC stdin.
const dir = (n: string) => { const d = `/tmp/peer-smoke-${n}-${process.pid}`; require('fs').mkdirSync(d, { recursive: true }); return d }
function start(name: string, port: number, allow: string) {
  const p = Bun.spawn(['bun', 'server.ts'], {
    cwd: import.meta.dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PEER_STATE_DIR: dir(name), PEER_NAME: name, PEER_BIND: '127.0.0.1', PEER_PORT: String(port), PEER_TOKEN: 'shh', PEER_ALLOW: allow, PEER_TIMEOUT_S: '10' },
  })
  const lines: any[] = []
  ;(async () => { for await (const chunk of p.stdout) for (const l of new TextDecoder().decode(chunk).split('\n')) if (l.trim()) { try { lines.push(JSON.parse(l)) } catch {} } })()
  ;(async () => { for await (const c of p.stderr) process.stderr.write(`[${name}] ${new TextDecoder().decode(c)}`) })()
  const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + '\n')
  return { p, lines, send }
}
const until = async (f: () => any, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await Bun.sleep(30) } return f() }
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

const A = start('A', 7601, 'B=http://127.0.0.1:7602')
const B = start('B', 7602, 'A=http://127.0.0.1:7601')
A.send(init); B.send(init); A.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); B.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
await Bun.sleep(800)

// A asks B.
A.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_peer', arguments: { peer: 'B', text: 'What is the meaning of life?' } } })
const note = await until(() => B.lines.find(l => l.method === 'notifications/claude/channel'))
console.log('B received:', note.params.content, '| meta:', JSON.stringify(note.params.meta))

// B's loop guard: asking while owing a reply is refused.
B.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_peer', arguments: { peer: 'A', text: 'ping' } } })
const guard = await until(() => B.lines.find(l => l.id === 5))
console.log('B ask_peer while pending →', guard.result.content[0].text.slice(0, 60))

// B's session answers.
B.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply_peer', arguments: { task_id: note.params.meta.task_id, text: 'Forty-two.' } } })
const replied = await until(() => B.lines.find(l => l.id === 2))
console.log('B reply_peer →', replied.result.content[0].text)
const answer = await until(() => A.lines.find(l => l.id === 1))
console.log('A ask_peer →', answer.result.content[0].text.replace(/\n/g, ' '))

// Card via plain HTTP, and wrong token.
console.log('card:', (await (await fetch('http://127.0.0.1:7602/.well-known/agent-card.json')).json()).name)
console.log('wrong token:', (await fetch('http://127.0.0.1:7602/', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status)
A.p.kill(); B.p.kill()
