# claude-peer

A2A v1.0 (Linux Foundation Agent2Agent) endpoint for a live Claude Code session, bound to a
private VPN address (nospoon). Built 2026-09-12; **loopback two-instance smoke passes**;
two-machine live test pending (Vaios). Spec: `docs/superpowers/specs/2026-09-12-claude-peer-design.md`.

- `a2a.ts` pure protocol (card, JSON-RPC parse, TaskStore, client builder) · `peer.ts` HTTP
  handler + `askPeer` client · `server.ts` MCP (tools `ask_peer`, `reply_peer`, `peers`) + `Bun.serve`.
- Wire facts pinned from `specification/a2a.proto`: methods `SendMessage`/`GetTask`/`CancelTask`;
  ProtoJSON names (`messageId`, `parts[{text}]`, `ROLE_USER`, `TASK_STATE_*`); card at
  `/.well-known/agent-card.json` with `supportedInterfaces[{url,protocolBinding:"JSONRPC",protocolVersion:"1.0"}]`;
  header `A2A-Version: 1.0`; errors -32001 TaskNotFound, -32004 Unsupported, -32009 Version.
- Sender identity = `Message.metadata.from` (claim; shared token). Loop guard = ask refused while
  any inbound task is pending. Blocking SendMessage waits `PEER_TIMEOUT_S` then returns WORKING.
- Smoke script (two stdio servers on loopback, driven over JSON-RPC): see git history / scratch;
  `bun test` covers protocol + endpoint.
- Not in v1: streaming, push, artifacts, per-peer tokens, follow-ups on an existing task.
