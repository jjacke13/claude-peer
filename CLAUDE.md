# claude-peer

A2A v1.0 (Linux Foundation Agent2Agent) endpoint for a live Claude Code session, bound to a
private VPN address (nospoon). Built 2026-09-12; **LIVE-VALIDATED 2026-09-13** laptop (10.0.0.2) ↔ box (10.0.0.1, the nospoon server/hetzner host)
over nospoon: `ask_peer box` → answered. Transfer gotcha: bundle clone needs `-b main`. Review 2026-09-12: 7 importants fixed (from-name grammar, 64 KB body + 20k text caps, timing-safe token, waiter leak, sender on task, curl in skill, escape-hatch doc). Spec: `docs/superpowers/specs/2026-09-12-claude-peer-design.md`.

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
- **Trust levels (2026-09-13):** `PEER_ALLOW=name=url:trusted` → inbound from that name AND that host
  gets `trusted="true"` meta → session treats it as an operator task under its own permission mode.
  Untrusted = answers only. Source-IP check via `server.requestIP` (name is a claim).
  **Trusted delegation LIVE 2026-09-13:** laptop→box "write+run a script" done under box auto mode.
- Not in v1: streaming, push, artifacts, per-peer tokens, follow-ups on an existing task.

## NEXT (Vaios, 2026-09-13) — multi-agent topology
Multi-peer already works (`PEER_ALLOW` is comma-separated; star topology). Two follow-ups requested:
1. **Per-peer tokens** — one `PEER_TOKEN` today = one trust circle. Grammar idea:
   `name=url:token[:trusted]` (token optional → falls back to `PEER_TOKEN`); inbound bearer
   matched per sender name+host, outbound uses that peer's token.
2. **Chains (A→B→C)** — loop guard refuses *any* `ask_peer` while an inbound task is pending.
   Replace with hop tracking: `Message.metadata.via = ["laptop","box"]`; refuse only when the
   target (or self) is already in `via`; cap depth (e.g. 4). Keep the "answer first" rule for
   direct A↔B cycles.
