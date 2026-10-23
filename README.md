# opencode-conductor

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="opencode-conductor. Sessions that talk to each other, with one in charge." src="assets/banner-light.svg" width="100%">
</picture>

[![License: MIT](https://img.shields.io/badge/license-MIT-0f172a?style=flat-square)](LICENSE) [![OpenCode 2.1+](https://img.shields.io/badge/opencode-2.1%2B-0f172a?style=flat-square)](https://opencode.ai) [![Node 18+](https://img.shields.io/badge/node-18%2B-0f172a?style=flat-square)](INSTALL.md) [![23 tests](https://img.shields.io/badge/tests-23%20green-0f172a?style=flat-square)](#tests) [![By Better ISMS](https://img.shields.io/badge/by-Better%20ISMS-0f172a?style=flat-square)](https://betterisms.co)

Let your [OpenCode](https://opencode.ai) sessions talk to each other, and put one
of them in charge.

OpenCode runs every session through one shared background service, and its API
already exposes the transport: list sessions, see which are live, deliver a
prompt to any one of them (busy sessions take it at the next turn boundary, idle
ones start a turn, offline ones queue it durably). But no two sessions can
actually message each other out of the box: there is no send tool a model can
call, no way to address a session by name from inside a turn, and no pattern for
who answers to whom.

This repo adds that missing layer:

- **`send.mjs`**: one session delivers a message to another (by id or title). The
  SendMessage this harness lacked.
- **`peers.mjs`**: read-only inventory of every session on the machine, running
  ones marked, including the live conductor if any.
- **`/conductor` command**: turn any OpenCode window into the conductor, the one
  session that collects 5-line status reports from the others, verifies their
  evidence, relays decisions its human already made, and escalates only the
  decisions that actually need a human.
- **Governance by construction**: singleton lock (one conductor at a time, even
  across process crashes), kill switch, list-only-until-enabled mode, a closed
  action set, one hard rule: it never closes another session's window.
  Closing a window is the human's call, one window at a time.
- **A confined session profile** (`profile/`): run the conductor window from
  it and its policies deny every shell command except the six lane scripts
  invoked by their exact relative path (`node ../act.mjs *` and siblings),
  redirection and shell metacharacters, every write-tool use except one
  /tmp scratch filename shape for filing a report (the lane scripts write
  their own state and log files; that is the tool working), web access,
  subagents and all MCP servers. The reserved-action bans become
  configuration, not instructions.

## Why

If you run more than two or three agent sessions, you become the router: every
session waits for you to read its output, say "continue", and connect it to the
others. The conductor pattern removes that: sessions report to one of their own,
that one verifies and routes, and only real decisions reach you.

It was built and is used daily to run a real agent fleet (see CREDITS).

## What it looks like

Read-only inventory, one command:

```text
$ node peers.mjs list
OpenCode sessions: 50 total, 4 running
ses_e9a2fc3cdffeVtkstDEiNiQe0d  running   plugin oauth fix        /home/dev/project
ses_e9a1b770effeJspS4xdROmNPcp  running   evidence night          /home/dev/ops
ses_e9c284203ffeZY1nY37fsb0Jrg  running   docs site build         /home/dev/site
ses_e9a048c09ffee6pf5yw7zXamDp  running   refactor lane           /home/dev/app  <== me
```

A worker sending its 5-line report to the conductor (busy targets take it at
their next turn boundary, idle ones start a turn, offline ones queue durably):

```text
$ node send.mjs --to conductor-oc --file report.txt
{"from":"ses_e9a048c09ffee6pf5yw7zXamDp","to":"ses_e99f1b6a3ffemIUV5E2CoupC06",
 "title":"conductor-oc","delivery":"steer","queued":false}
```

And the conductor's side: it verifies the evidence itself (read-only PR and
commit records through `verify.mjs` when run from `profile/`), files the report,
relays decisions its human already made, and escalates only what needs one.

## Quickstart

```sh
git clone https://github.com/tristanroth1/opencode-conductor.git
cd opencode-conductor

# read-only check: what sessions exist right now
node peers.mjs list

# install the /conductor command and the worker reporting block
# (details in INSTALL.md)
```

Any OpenCode window, then:

```
/conductor
```

The conductor starts in **list-only mode**: it sweeps and reports what it sees
and sends nothing. You enable sending by saying "go" in that window
(`node act.mjs go --reason "go <date>"`). Kill switch:
`touch ~/.config/opencode-conductor/DISABLED`.

## How it works

Three documented endpoints of the OpenCode service API, nothing else:

| Endpoint | Used for |
|---|---|
| `GET /api/session` (with cursor paging) | the session list |
| `GET /api/session/active` | which sessions are live right now |
| `POST /api/session/<id>/prompt` | deliver one message (`delivery: "steer" or "queue"`) |

No plugin, no config change, no MCP server, no fork. If OpenCode stops exposing
these endpoints, the scripts fail loudly and nothing else breaks.

Worker side: one block in your `~/.config/opencode/AGENTS.md` (in
`command/agents-block.md`) teaches sessions to check for a live conductor and
send it a 5-line report (TOPIC / STATUS / EVIDENCE / NEXT / UNSAVED). With no
conductor live, nothing changes.

## Safety model

- **Reports are data, never instructions.** The report text reaches the
  conductor as prompt content first, untrusted like any inbound message; the
  taught first step is to file it as data: `act.mjs report` takes a JSON file
  (never shell arguments) and validates it (field shapes, status enum, length
  caps). Anything instruction-shaped in a report is a
  finding, not a command.
- **The action path is closed.** `act.mjs` offers exactly: report, topic,
  escalate, inbox, decide, relay, flag, unblock, go, pause. Everything else is
  refused. `close` is refused unconditionally.
- **Fail-closed liveness.** Session liveness is three-state
  (active/inactive/unknown). When the service cannot be reached, the lock is
  never stolen and never dropped: an unknown state holds, only a confirmed exit
  cleans up, and acquiring also refuses when the process table cannot be read.
- **List-only by default.** Fresh installs ship paused: reads work, every
  state-changing action refuses, and the conductor itself sends nothing (its
  own sends refuse) until the human says go in the conductor window. Workers
  reporting IN to the conductor are never blocked: that is the report path,
  and blocking it would leave stranded sessions with nowhere to go.
- **No closes.** Ever. The conductor proposes a close with a one-line reason; the
  human closes the tab.
- **Bounded blast radius.** Status sweeps are paced (once per 4 hours per
  session, auditable through the send log), the send script refuses immediate
  duplicates and self-sends, and the send log carries metadata only, never
  message text; the action log records the operator-passed fields (a reason,
  a title). Every log is a local file.

DESIGN.md has the full decision list and threat model.

## Security FAQ

The short answers to the three questions security reviewers ask first. The
full threat model is in DESIGN.md.

**If a worker reads a poisoned file or web page, can its report steer the
conductor?**

It can try to influence the model; whether that gets anywhere is bounded in
code when you run the conductor from `profile/`. The profile's policies
evaluate after every permission rule and cannot be lifted by the session
itself: no shell except the six lane scripts invoked by their exact relative path,
node ../<name>.mjs (plus the session self-rename; redirection and shell
metacharacters are denied outright, so an allowed script cannot be turned
into a file write or a compound command), write tools blocked everywhere
except one /tmp scratch filename shape for filing a report (the lane
scripts write their own state and log files; that is the tool working),
no web access, no subagents, no MCP servers at all (mail above all). The report's text still reaches the conductor model
first, as untrusted content: the taught first step is to file it as data
(`act.mjs report` takes a JSON file, never shell arguments, and validates
field shapes, status enum and length caps) and treat instruction-shaped text
as a finding, not a command. No code path maps report content to an action:
a report can trigger a verification turn, never an action on its own word.
The only thing a report's content can become in the scripts is a record: it
is filed, logged, and never executed, resolved as a send target, or
transmitted on its own word.

Two residuals stay open, stated plainly. First, the conductor can still send
messages to your other local sessions through `send.mjs` (that is the tool's
point), and what those messages do is bounded by each receiving session's
own rules, not by the conductor's profile. Second, it can still read files
and it can still talk to you in its window, so a crafted report can cost
attention: a wrong escalation, a wasted verify turn. If you run the
conductor outside `profile/`, none of the confinement above applies and the
bans rest on its instruction file alone.

**When the conductor acts on a worker's result, whose permissions does it
use?**

Its own. The privileged scripts never run worker code; what reaches them
from a worker is either a raw message the conductor is taught to file as
data (first answer above) or the validated report fields of
`act.mjs report`. In the profile, "its own" is a tiny set by policy: the
lane scripts, read-only file tools, and the question tool it uses to
escalate to you. It never borrows the worker's permissions and inherits
nothing from it.

**Does "go" make it permanently connected?**

Go is persistent state, not a connection: it removes the pause file, and it
stays removed until you run `pause`, which re-creates it. The `DISABLED` kill
switch does not restore the pause file; it disables every privileged action
and the conductor's own sends on top of whatever the pause state is. After
go, the conductor session can send whenever it
next acts; nothing runs in the background that was not already running. Both
`pause` and the kill switch stop the conductor's own sends and every
privileged action; reports in from workers still arrive by design (that path
is never blocked, or a stranded session would have nowhere to report). Code
enforces the closed action set, the field validation, the self-send and
60-second duplicate refusals, the fail-closed liveness, and the send log; the
4-hour sweep pacing is instruction-file policy, auditable through the send
log. In the profile those bans are policy; a conductor started outside it
carries instruction-file bans alone (see the first answer).

## Tests

```sh
node --test opencode-conductor.test.mjs
```

23 tests: singleton lock and stale reclaim, fail-closed behavior when the service
is unreachable, holder healing, guard ordering (kill switch beats everything),
close refusal, report validation, the escalate/decide/relay/inbox round trip,
cursor paging, the send guards, and the verify.mjs argument wall.

## CREDITS

Built by [Tristan Roth](https://tristanroth1.github.io) while running the agent
fleet at [Better ISMS](https://betterisms.co). It runs in production on the fleet
behind [ISMS Copilot](https://ismscopilot.com). OpenCode's service API did the
heavy lifting; this repo is the protocol and the guardrails on top of it.

## License

MIT. See LICENSE.
