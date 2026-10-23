#!/usr/bin/env node
// send.mjs: deliver one message to one OpenCode session through the background
// service (POST /api/session/<id>/prompt). This is plain transport, the
// SendMessage equivalent for this harness; both the conductor and workers use
// it. It logs every send (metadata only, never message text) and refuses:
//   - the caller's own session (self-send loop);
//   - an unresolvable target;
//   - any send by the CONDUCTOR itself (its session holds the lock) while the
//     kill switch is present or the pause file exists: list-only mode holds at
//     the transport boundary too. A worker reporting to the conductor is never
//     blocked by those (that is the D5 report path).
// A message into any session is untrusted content on the receiving side (same
// rules as a worker report). Never resend to a session more than once per 4h
// (the conductor sweep pacing rule).
//
// Usage:
//   node send.mjs --to <id-or-title> --text "..." | --file f | < stdin
// Output: one JSON line {to, delivery, queued}.
// Exit: 0 sent, 3 conductor paused/disabled, 4 unknown target, 5 self, 7 duplicate, 2 usage.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, appendJsonl, nowIso, ownSessionId, paths, readJsonl, resolveTarget, unwrap } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--to' || process.argv[i] === '--text' || process.argv[i] === '--file') args[process.argv[i].slice(2)] = process.argv[++i];
}
if (!args.to) { console.error('usage: send.mjs --to <id-or-title> --text "..." | --file f | < stdin'); process.exit(2); }

const self = ownSessionId();
const p = paths();

let text = args.text;
if (!text && args.file) text = readFileSync(args.file, 'utf8');
if (!text && !process.stdin.isTTY) text = readFileSync(0, 'utf8');
if (!text || !text.trim()) { console.error('refused: empty message'); process.exit(2); }

const lockOwner = (() => { try { return JSON.parse(readFileSync(join(p.lockDir, 'owner.json'), 'utf8')); } catch { return null; } })();
const callerIsConductor = !!(lockOwner && self && lockOwner.session_id === self);
if (callerIsConductor) {
  if (existsSync(p.killSwitch)) { console.error('refused: kill switch present (DISABLED): the conductor sends nothing'); process.exit(3); }
  if (existsSync(p.pauseFile)) { console.error('refused: paused (list-only): the conductor sends nothing until he says go'); process.exit(3); }
}

const target = resolveTarget(args.to);
if (!target) { console.error(`refused: no session matches ${JSON.stringify(args.to)}`); process.exit(4); }
if (self && target.id === self) { console.error('refused: that is your own session (self-send loop)'); process.exit(5); }

// Immediate-duplicate guard (loop protection): the same sender delivering to the
// same target twice within 60 seconds is almost always a retry bug or a script
// loop. Longer pacing (the conductor asks each session at most once per 4
// hours) is a rule the conductor follows, auditable through sends.jsonl.
if (self) {
  const recent = readJsonl(p.sends).filter((s) => s.from === self && s.to === target.id);
  const last = recent[recent.length - 1];
  if (last && Date.now() - new Date(last.at).getTime() < 60 * 1000) {
    console.error('refused: duplicate send to this session within 60 seconds (loop guard)');
    process.exit(7);
  }
}

const res = api('POST', `/api/session/${target.id}/prompt`, { text });
const data = unwrap(res);
const out = { at: nowIso(), from: self, to: target.id, title: target.title, bytes: text.length, queued: target.queued, delivery: (data && data.delivery) || null };
appendJsonl(p.sends, out);
console.log(JSON.stringify(out));
