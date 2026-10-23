# Design

What this tool decided to be, and why. Written as decisions so you can argue
with them.

## Context

OpenCode runs all sessions through one background service. Its API exposes
session listing, a live-session registry, and per-session prompt delivery
(busy sessions steer at the next turn boundary; idle ones start a turn; offline
ones queue durably in a per-session inbox). That is transport. What is missing
is the protocol: addressing, reporting, authority, and safety.

## Decisions

1. **Harness-native transport, no adapter layer.** Everything goes through the
   documented service API via the `opencode` CLI. No plugin, no MCP server, no
   sidecar process. If the endpoints drift, we fail loudly rather than silently
   degrade. Rejected: a neutral bus every session must load (more moving parts,
   and it fights the harness instead of using it).

2. **One conductor, not a mesh.** Any session can message any session (that is
   the transport), but the taught pattern is hub-and-spoke: workers report up,
   the conductor relays down. Full peer-to-peer between agent sessions is a
   coordination mess with no owner; one steering session has an owner.

3. **Singleton by construction, one honest residual.** An atomic mkdir lock
   plus a detached holder process that lives exactly as long as the owner
   session. Deleting the lock directory does not admit a second conductor while
   the first lives: the holder re-creates it within its tick (5s default), and
   acquiring also refuses whenever the process table cannot be read. Liveness
   is three-state: active, inactive, unknown. Unknown holds the lock. Only
   confirmed inactive releases it. A service outage can therefore never split
   the conductor role in two. Residual window: between a lock-dir deletion and
   the holder's next heal tick, a rival whose process-table read also fails
   could in principle acquire; both halves of that window require a failure,
   and acquiring fails closed on the process-table half.

4. **List-only until enabled.** Fresh state ships with a pause file. Reads work,
   every write and every conductor send refuses. The human enables it in the
   conductor window. The kill switch (DISABLED file) stops everything, always,
   including the enable step.

5. **Closed action set.** The privileged path offers exactly: report, topic,
   escalate, inbox, decide, relay, flag, unblock, go, pause. Anything else is
   refused by the parser. There is no generic "run" or "exec" capability to
   misuse.

6. **No closes.** The conductor never closes another session's window. It
   verifies a session is done, proposes the close with a one-line reason, and
   the human closes the tab (or a script the human trusts does). Closing a
   window kills a human's view of in-flight work; that decision stays human.

7. **Reports are data.** The report's text reaches the conductor model first,
   as untrusted prompt content (see Threat model); the taught first step is to
   file it as data: `act.mjs report` takes a JSON file (never shell
   arguments) and validates it (sender session id shape, topic charset,
   status enum, length caps). The full validated fields go to the conductor's
   local report file (state dir), which is meant to stay on that machine; the
   action log records the operator-passed fields of every action, and the
   send log records metadata only. A report can trigger
   verification, never an action on its own word. The conductor relays only
   decisions the human typed in the conductor window.

8. **Bounded delivery.** Status sweeps are paced by the conductor (at most one
   ask per session per 4 hours; every send is logged so pacing is auditable),
   and the send script refuses an immediate duplicate (same sender and target
   within 60 seconds) as loop protection. The conductor refuses to message
   itself (self-send guard). Sends log metadata only, never message text.
   Messages into a session are untrusted content on the receiving side, same
   as any prompt.

9. **Worker side is additive and inert by default.** One block in the global
   agent instructions: if a live conductor exists, send it the 5-line report;
   otherwise print the same 5 lines on screen, exactly as before. No conductor,
   no behavior change.

## Threat model

- **Trust boundary.** Same-machine, same-user processes. The OpenCode service
  socket is reachable by anything running as your user; this tool adds no new
  listener and no credential.
- **Untrusted content.** Report text, session titles, and message bodies are
  data. Instruction-shaped text is reported, not obeyed. Field validation
  blocks shell-metacharacter topics from ever reaching a command line.
- **Identity gap (known).** The service does not authenticate senders to each
  other: any local process can POST a prompt as any "sender". Report text also
  reaches the conductor model as untrusted prompt content BEFORE validation:
  the first conductor step is to treat it as data, validate it and file it,
  and instruction-shaped text inside a report is a finding to report, never an
  instruction to follow. The defenses are layered, not absolute. The
  conductor's own scripts offer a closed action set (no spend, send,
  credential, delete, merge or prod capability exists in act.mjs to misuse)
  and verify evidence independently before routing anything. But the conductor
  is still a normal agent session with its ordinary shell and tools: the
  reserved-action bans (no external sends, no spend, no credentials, no
  deletes, no merges, no prod) are enforced by its instruction file, not by
  technical confinement. A forged or crafted report can therefore cost a turn
  and try to influence the model; what it cannot do is invoke a privileged
  conductor capability, because none exists outside the closed set. Running
  the conductor session with a tool allowlist or sandbox would make this
  confinement technical; that is future work (see Not built).
- **Spoofed conductor title.** A worker session could name itself
  `conductor-oc` and phish reports. Those reports are 5-line statuses; replies
  go to the id the conductor verified, not to a title. Revisit if OpenCode
  grows session identity.
- **Failure behavior.** Kill switch stops all actions and all conductor sends.
  Pause file is the normal list-only state. The holder exits on its own when
  the owner session ends. If everything dies, workers fall back to on-screen
  reports; nothing depends on the conductor being alive.
- **Cost.** Delivering to an idle session starts a model turn on that session.
  That is the one real cost of the design; the 4-hour pacing and the
  list-only default bound it.

## Not built (yet)

- Technical confinement for the conductor session (tool allowlist or sandbox):
  today the reserved-action bans live in its instruction file, not in a
  sandbox boundary.

- Closing tabs programmatically (with per-window human confirmation and
  revalidation) is deliberately out.
- Interop with other harnesses (Claude Code has a native but undocumented
  cross-session protocol; Grok, Vibe and Codex have none). The protocol here is
  portable; adapters are future work.
- A plugin exposing list_peers / send_message / read_inbox as model tools with
  event-driven wake. The CLI scripts need nothing installed; a plugin would
  make sends callable mid-turn without a shell.
