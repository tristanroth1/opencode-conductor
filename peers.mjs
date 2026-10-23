#!/usr/bin/env node
// peers.mjs: read-only view of the OpenCode sessions on this Mac (the
// ListAgents equivalent for this harness). GET calls only; it never sends.
//
// Usage:
//   node peers.mjs list [--json]          all sessions, running marked
//   node peers.mjs running [--json]       only sessions with a live TUI
//   node peers.mjs conductor [--json]     the live OpenCode conductor (title conductor-oc)
//   node peers.mjs resolve <id-or-title>  one session or nothing
// Exit: 0 found/ok, 4 none found (conductor/resolve), 2 usage.

import { CONDUCTOR_TITLE, listSessions, ownSessionId, paths, guardRead } from './lib.mjs';

function fmt(s, mine) {
  const flag = s.running ? 'running ' : 'idle    ';
  const me = mine ? ' <== me' : '';
  const title = (s.title || '(untitled)').slice(0, 70);
  return `${s.id}  ${flag}  ${title}  ${s.directory || ''}${me}`;
}

const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes('--json');
const sessions = listSessions();
const mine = ownSessionId();
const p = paths();
const g = guardRead(p);

if (cmd === 'list') {
  if (json) { console.log(JSON.stringify({ paused: g.paused, disabled: g.disabled, self: mine, sessions }, null, 1)); process.exit(0); }
  console.log(`OpenCode sessions: ${sessions.length} total, ${sessions.filter((s) => s.running).length} running${g.paused ? ' (conductor paused: list only)' : ''}${g.disabled ? ' (conductor kill switch present)' : ''}`);
  for (const s of sessions) console.log(fmt(s, s.id === mine));
  process.exit(0);
} else if (cmd === 'running') {
  const rows = sessions.filter((s) => s.running);
  if (json) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  for (const s of rows) console.log(fmt(s, s.id === mine));
  process.exit(0);
} else if (cmd === 'conductor') {
  const rows = sessions.filter((s) => s.running && s.title === CONDUCTOR_TITLE && s.id !== mine);
  if (json) { console.log(JSON.stringify(rows, null, 1)); process.exit(rows.length ? 0 : 4); }
  if (!rows.length) { console.log(`no live OpenCode conductor (no running session titled ${CONDUCTOR_TITLE})`); process.exit(4); }
  for (const s of rows) console.log(fmt(s, false));
  process.exit(0);
} else if (cmd === 'resolve') {
  const ref = args[1];
  if (!ref) { console.error('usage: peers.mjs resolve <id-or-title>'); process.exit(2); }
  const hit = sessions.find((s) => s.id === ref)
    || sessions.find((s) => s.running && s.title === ref)
    || sessions.find((s) => s.title === ref);
  if (!hit) { console.error(`no session matches ${JSON.stringify(ref)}`); process.exit(4); }
  if (json) console.log(JSON.stringify(hit, null, 1)); else console.log(fmt(hit, hit.id === mine));
  process.exit(0);
} else {
  console.error('usage: peers.mjs list|running|conductor|resolve [--json]');
  process.exit(2);
}
