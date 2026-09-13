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
PEER_ALLOW=pi=http://10.7.0.3:7500/,hetzner=http://10.7.0.4:7500/:trusted   # :trusted = may assign me tasks
# PEER_PORT=7500  PEER_TIMEOUT_S=300  PEER_DESCRIPTION=...
```

## Trust levels (configuration only)

By default a peer may only **ask**: its text reaches the session as a question and the
session answers — it never runs commands, edits files or changes config because a peer said
so. To let another session **assign work** (build, debug, test something for you), mark that
peer `:trusted` on the machine that will do the work:

```
# on box (the worker):
PEER_ALLOW=laptop=http://10.0.0.2:7500/:trusted
```

A message then arrives as `<channel … peer="laptop" trusted="true">` and the session treats
it as a task from its operator, executed under **its own permission mode** (auto mode on box →
it builds, compiles, commits, and replies with the result; a prompting mode → the human at
box's terminal approves as usual). Two checks must both pass for `trusted="true"`: the
sender's name is configured `:trusted` **and** the request arrived from that peer's
configured address — the name in the message is only a claim, the source address is not.
Anything else is delivered untrusted. Trust is decided on the receiving machine; a caller
cannot grant it to itself. Long tasks: the asker's `PEER_TIMEOUT_S` (default 300 s) bounds
how long `ask_peer` waits.

## Local sessions on one machine (v0.3)

One "main" session can drive worker sessions in other repos on the same box, with no
`PEER_ALLOW` edits. In each worker project:

```
/peer:configure project hades 7511      # writes ./.claude/peer.env
```

```
# ./.claude/peer.env — overrides the global file for sessions started in this directory
PEER_NAME=hades
PEER_BIND=127.0.0.1
PEER_PORT=7511
```

Precedence: real environment > `./.claude/peer.env` (found via `CLAUDE_PROJECT_DIR`) > global
`.env`. The token stays in the global file only. While a session runs it holds
`~/.claude/channels/peer/local/<name>.json` (url, pid, project); every other local session
lists it in `peers` as **trusted** (same user, same machine) and can `ask_peer` it. The entry is
removed on exit; stale ones (dead pid) are swept on sight. A second session with a name already
live refuses to start. Explicit `PEER_ALLOW` entries win over registry entries of the same name.

`/peer:configure project <name> <port>` also drops a launcher at `./.claude/worker`:

```
.claude/worker          # start the worker: tmux session <name>, auto mode, peer plugin only, resumes last session
.claude/worker --stop   # kill it
.claude/worker --fg     # run in this terminal
```

It disables the talk/simplex plugins for the worker (`enabledPlugins` is global, and a worker's
talk server would steal the hold-to-talk key from the main session). First launch in a repo:
`tmux attach -t <name>`, answer the folder-trust and dev-channels prompts once, `Ctrl-b d`.

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
