# claude-peer — A2A endpoint for a live Claude Code session (design note, NOT BUILT)

**Date:** 2026-09-12 · **Status:** agreed in principle over voice (Vaios), build after wake-word decision · **Name:** `claude-peer` (`claude-a2a` is taken on GitHub by headless wrappers)

## Goal

Two or more Claude Code sessions on different machines talk to each other over Vaios's own
network — no Anthropic relay, no public ports — using the Linux Foundation **A2A** protocol
(v1.0, JSON-RPC over HTTP, Agent Card at `/.well-known/agent.json`, Tasks/Messages, SSE
streaming optional). Nobody has this shape yet: existing projects are either client-only
bridges or headless Claude-as-a-service; this one delivers into a **live interactive session**
as a channel, same as claude-simplex and claude-talk.

## Shape (same skeleton as claude-simplex)

```
claude-peer/
  .claude-plugin/{plugin.json, marketplace.json}   name "peer"
  .mcp.json, package.json                          Bun, @modelcontextprotocol/sdk only
  server.ts        MCP channel server + Bun.serve A2A endpoint bound to PEER_BIND (nospoon IP)
  a2a.ts           pure: Agent Card builder, JSON-RPC parse/validate, task store, loop guard
  a2a.test.ts      bun test with an in-process fake peer
  skills/configure/SKILL.md   /peer:configure name|bind|token|add <name>=<url>|remove|status
  AGENTS.md, README.md, flake.nix
```

- **Inbound:** `POST /` JSON-RPC `message/send` (and `tasks/get`, `tasks/cancel`) → bearer token
  check → allowlisted peer name → `notifications/claude/channel { content, meta: { peer, task_id } }`.
  The session's reply is sent back with a `reply_peer` tool (task completes) — or, v2, streamed
  via `message/stream` SSE.
- **Outbound:** tool `ask_peer { peer, text }` → client `message/send` to that peer's URL; the
  peer's answer returns as the tool result (blocking, timeout `PEER_TIMEOUT_S`, default 300).
- **Agent Card:** `GET /.well-known/agent.json` — name, description (from config), skills
  (one: "chat"), url = `http://<bind>:<port>/`, auth = bearer.
- **Config** `~/.claude/channels/peer/.env`: `PEER_NAME` (required), `PEER_BIND` (required —
  the nospoon interface address, never 0.0.0.0), `PEER_PORT=7500`, `PEER_TOKEN` (required,
  shared secret; second gate behind the VPN), `PEER_ALLOW=name=http://ip:port,…` (peers that
  may ask AND that we may ask).
- **Loop guard** (lifted from hades Bridge): a turn that originated from a peer cannot itself
  call `ask_peer` (hard veto) — prevents A↔B ping-pong.
- **Transport:** plain HTTP inside nospoon (encrypted + authenticated by the VPN). Nothing here
  opens firewall ports. Works through CGNAT because nospoon does.

## Non-goals (v1)

SSE streaming, multi-hop, push notifications, artifacts/files, discovery (peers are static
config), TLS (the VPN provides it), permission relay (auto mode).

## Tests / live

`bun test`: card shape, JSON-RPC validation, token/allowlist gates, loop guard, ask→reply
round-trip against an in-process fake peer. Live: two nospoon nodes (laptop + Pi or hetzner),
each running a session with the plugin; A asks B a question, B's session answers, A hears it.

## Estimate

One session to build + review (~300 lines), one short two-machine smoke with Vaios.
