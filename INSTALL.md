# Install

Node 18+ and the `opencode` CLI (2.1+) on PATH. No config change, no plugin,
nothing installed into the OpenCode service.

```sh
git clone https://github.com/tristanroth1/opencode-conductor.git
cd opencode-conductor

# optional: run the tests
node --test opencode-conductor.test.mjs

# 1. the /conductor command
cp command/conductor.md ~/.config/opencode/commands/conductor.md
#    no path editing needed when the conductor window runs from profile/:
#    the command's ../ paths resolve to this clone. The worker block in
#    step 2 is the only place that needs your clone path.

# 2. the worker reporting block
#    append command/agents-block.md (the markdown block inside it) to
#    ~/.config/opencode/AGENTS.md, with your clone path

# 3. first-run state: list-only until you enable it
mkdir -p ~/.config/opencode-conductor
printf 'initial: list-only\n' > ~/.config/opencode-conductor/PAUSED
```

Start it: any OpenCode window, `/conductor`. It sweeps read-only and prints
what it sees. Enable sending by saying go in that window (run from profile/,
the conductor session's own cwd):

```sh
node ../act.mjs go --reason "go 2026-11-01"
```

**Run the conductor session itself from `profile/`** (`cd profile && opencode`,
then `/conductor`). The profile's policies are the technical confinement
described in the README Security FAQ: no shell except the lane scripts, no
write-tool use except one /tmp scratch filename shape (the scripts write
their own state and logs: that is the tool working), no web, no subagents,
no MCP servers. A conductor
started anywhere else still works, but its reserved-action bans rest on the
command's instruction file alone.

State lives in `~/.config/opencode-conductor/` (lock, kill switch, pause file,
reports) and logs in `~/.local/state/opencode-conductor/`. Override with
`OPENCODE_CONDUCTOR_STATE` / `OPENCODE_CONDUCTOR_LOGS`.

Kill switch (stops every action and every conductor send):

```sh
touch ~/.config/opencode-conductor/DISABLED   # stop
rm ~/.config/opencode-conductor/DISABLED      # resume
```

Uninstall: `rm ~/.config/opencode/commands/conductor.md`, remove the block from
AGENTS.md, optionally `rm -rf ~/.config/opencode-conductor
~/.local/state/opencode-conductor`. No traces in the OpenCode service.
