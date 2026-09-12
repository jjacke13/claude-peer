# claude-peer

> AI agent setting this up? Read [AGENTS.md](AGENTS.md) — step-by-step, verifiable.

An **A2A** (Agent2Agent, Linux Foundation, v1.0) endpoint for a *live* Claude Code session.
Sessions on different machines ask each other questions over your own private network — no
cloud relay, no public ports. Any A2A v1.0 client can talk to it; any A2A agent can be asked.

## How it works

- The plugin's server listens on `PEER_BIND:PEER_PORT` (your VPN address, e.g. nospoon) and
  serves the Agent Card at `/.well-known/agent-card.json` plus JSON-RPC `SendMessage`,
  `GetTask`, `CancelTask` (bearer token required, `A2A-Version: 1.0`).
- An inbound `SendMessage` becomes a Task and lands in the session as
  `<channel source="plugin:peer:peer" peer="…" task_id="…">`. The session answers with the
  `reply_peer` tool, which completes the Task and unblocks the caller.
- `ask_peer { peer, text }` sends a blocking `SendMessage` to a configured peer and returns
  its answer; `peers` lists peers and pending questions.
- Loop guard: while a peer question is unanswered, `ask_peer` is refused.

## Install

```
claude plugin marketplace add jjacke13/claude-peer      # or a local path
/plugin install peer@claude-peer
claude --dangerously-load-development-channels plugin:peer@claude-peer
```
From a checkout: `claude --plugin-dir /path/claude-peer --dangerously-load-development-channels plugin:peer@inline`.

## Configure (`~/.claude/channels/peer/.env`, or `/peer:configure`)

```
PEER_NAME=laptop
PEER_BIND=10.7.0.2                 # this machine's nospoon address — never 0.0.0.0
PEER_TOKEN=<same secret on every peer>
PEER_ALLOW=pi=http://10.7.0.3:7500/,hetzner=http://10.7.0.4:7500/
# PEER_PORT=7500  PEER_TIMEOUT_S=300  PEER_DESCRIPTION=...
```

## Security model

Transport security comes from the VPN (encryption + who can reach the address). The bearer
token is the second gate; the card is public on that network by spec. The sender's name is a
claim in `Message.metadata.from` (shared token = no per-peer identity; v2). Peer text is
untrusted input: the session answers, it never acts on it.

## Test

```sh
bun test                       # protocol + endpoint, in-process
```
Two-machine smoke: on each, configure, launch, `peers` → both reachable; from A:
"ask pi what time it is" → B's session sees the question, answers, A prints it.

## Not in v1
SSE streaming (`SendStreamingMessage`), push notifications, artifacts/files, per-peer
tokens, discovery, TLS (VPN provides it), follow-up messages on an existing task.
