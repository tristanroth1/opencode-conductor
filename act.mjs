#!/usr/bin/env node
// act.mjs (OpenCode lane): the only path for the conductor's state-changing
// actions (DESIGN.md). Closed capability set: every write capability
//   1. refuses while the kill switch exists (DISABLED),
//   2. refuses while the pause file exists (list-only mode), except `go`,
//   3. refuses unless the caller's session (OPENCODE_SESSION_ID) holds the
//      conductor lock, so only the conductor window can act,
//   4. logs to actions.jsonl (metadata plus the operator-passed fields such as
//      a reason or title; sends never log message text; reports with customer
//      names stay in the local state dir, never synced).
// There is NO close capability and never will be one in this file: closing
// another session's window is ask-first (the human decides per window, never
// the agent; DESIGN.md). `close` is refused unconditionally.
//
// Capabilities:
//   status                                 read-only sweep summary
//   report   --file f (JSON: from, topic, status, evidence, next, unsaved) or stdin
//   topic    --topic T --session S         topic -> live session map
//   escalate --id T --title T --why W --do D --risk R
//   inbox    --all                          end of day: open escalations to the 09:00 carrier
//   decide   --id T --topic T --quote Q --gloss G     his verbatim answer
//   relay    --decision ID [--to S]         authorize + log; the send itself goes through send.mjs
//   flag     --line "..."                   priority drift
//   unblock  --blocker B --owner O          log only
//   go       --reason "<recorded reason>"    removes the pause file (human enable step)
//   pause    --reason "..."                 restores list-only mode
//   close    (anything)                     refused, always
// Exit: 0 ok, 3 refused (guard), 4 not found, 6 close refused, 2 usage.

import { existsSync, mkdirSync, appendFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, guardRead, guardWrite, nowIso, ownSessionId, paths, readJson, readJsonl } from './lib.mjs';

const p = paths();
const args = {};
const rest = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
  else rest.push(process.argv[i]);
}
const cmd = rest[0];
const self = ownSessionId();

function fail(why, code = 3) { console.error(`refused: ${why}`); process.exit(code); }
function requireFlags(list) {
  for (const f of list) if (!args[f]) fail(`missing --${f}`, 2);
}

// Lock ownership: the caller's session must be the lock owner (the conductor
// window). A caller with no OPENCODE_SESSION_ID (a cron, a random shell) is
// refused outright: only an identified session can act.
function lockOwner() {
  try { return JSON.parse(readFileSync(join(p.lockDir, 'owner.json'), 'utf8')); } catch { return null; }
}
function requireLock() {
  const owner = lockOwner();
  if (!owner || !owner.session_id) fail('no conductor lock is held (start /conductor first)');
  if (!self) fail('no OPENCODE_SESSION_ID in this environment: only an OpenCode session under the conductor lock may act');
  if (owner.session_id !== self) fail(`lock held by session ${owner.session_id}, not by you (${self})`);
}

function killSwitchRefusal() {
  if (existsSync(p.killSwitch)) return `kill switch present (${p.killSwitch}): every action refuses until it is removed`;
  return null;
}

function logAction(action, extra = {}) {
  appendJsonl(p.actions, { at: nowIso(), session: self, action, ...extra });
}

if (cmd === 'status') {
  const g = guardRead(p);
  const state = {};
  for (const line of readJsonl(p.actions)) {
    if (line.action === 'escalate') state[line.id] = line.state || 'open';
    else if (line.action === 'inbox' && line.id in state) state[line.id] = 'inboxed';
  }
  console.log(JSON.stringify({
    paused: g.paused, disabled: g.disabled, self,
    lock: lockOwner(),
    openEscalations: Object.entries(state).filter(([, s]) => s === 'open').map(([id]) => id),
  }, null, 1));
  process.exit(0);
}

if (cmd === 'close') {
  fail('this tool never closes windows: closing a session window is the human\'s call, one window at a time (DESIGN.md). Verify the session, propose the close with a one-line reason, and let the human close the tab', 6);
}

if (cmd === 'go') {
  requireFlags(['reason']);
  const ks = killSwitchRefusal();
  if (ks) fail(ks);
  if (String(args.reason).trim().length < 4) fail('--reason is required and recorded: say why it is being enabled (the human enable step)');
  requireLock();
  if (!existsSync(p.pauseFile)) { console.log('already live (no pause file)'); process.exit(0); }
  rmSync(p.pauseFile, { force: true });
  logAction('go', { reason: args.reason });
  console.log(`live (pause removed): ${args.reason}`);
  process.exit(0);
}

if (cmd === 'pause') {
  requireFlags(['reason']);
  const ks = killSwitchRefusal();
  if (ks) fail(ks);
  requireLock();
  mkdirSync(p.state, { recursive: true });
  appendFileSync(p.pauseFile, `${nowIso()} ${args.reason}\n`);
  logAction('pause', { reason: args.reason });
  console.log(`paused (list only): ${args.reason}`);
  process.exit(0);
}

if (!['report', 'topic', 'escalate', 'inbox', 'decide', 'relay', 'flag', 'unblock'].includes(cmd)) {
  console.error('usage: act.mjs status | report | topic | escalate | inbox | decide | relay | flag | unblock | go | pause (close is refused, see header)');
  process.exit(2);
}

// Worker-report text never travels as command arguments (F4): the conductor
// writes the report to a JSON file or pipes it via stdin, act.mjs reads it as
// data and validates it. Fields: from, topic, status, evidence, next, unsaved.
function readReportFields() {
  let raw = null;
  if (args.file) {
    try { raw = readFileSync(args.file, 'utf8'); } catch (e) { fail(`cannot read --file ${args.file}`); }
  } else if (!process.stdin.isTTY) {
    raw = readFileSync(0, 'utf8');
  } else fail('report needs --file <json> or stdin (worker text never passes as arguments)', 2);
  let body = null;
  try { body = JSON.parse(raw); } catch { fail('report file is not valid JSON'); }
  if (!body || typeof body !== 'object') fail('report file must be a JSON object');
  const from = String(body.from || '');
  if (!/^ses_[A-Za-z0-9]{6,}$/.test(from)) fail('report field "from" must be a session id (ses_...)');
  const clean = (v, cap) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, cap);
  const topic = clean(body.topic, 120);
  const status = clean(body.status, 30);
  if (!topic) fail('report field "topic" is required');
  if (!/^[A-Za-z0-9:_. ,+-]+$/.test(topic)) fail('report field "topic" may only contain ids, slugs and plain words (no prose, no shell chars)');
  if (!['CLOSE', 'NEEDS-HUMAN', 'WORK-REMAINING'].includes(status)) fail('report field "status" must be CLOSE, NEEDS-HUMAN or WORK-REMAINING');
  return { from, topic, status, evidence: clean(body.evidence, 400), next: clean(body.next, 400), unsaved: clean(body.unsaved, 400) };
}

const g = guardWrite(p);
if (!g.ok) fail(g.why);
requireLock();

if (cmd === 'report') {
  const r = readReportFields();
  appendJsonl(p.reports, { at: nowIso(), ...r });
  logAction('report', { from: r.from, topic: r.topic, status: r.status });
  console.log('report stored');
  process.exit(0);
}

if (cmd === 'topic') {
  requireFlags(['topic', 'session']);
  const topics = readJson(p.topics) || {};
  topics[args.topic] = { session: args.session, at: nowIso() };
  mkdirSync(p.state, { recursive: true });
  const tmp = `${p.topics}.tmp-${process.pid}`;
  appendFileSync(tmp, JSON.stringify(topics, null, 1));
  try { renameSync(tmp, p.topics); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  logAction('topic', { topic: args.topic, owner: args.session });
  console.log(`topic ${args.topic} -> ${args.session}`);
  process.exit(0);
}

if (cmd === 'escalate') {
  requireFlags(['id', 'title', 'why', 'do', 'risk']);
  logAction('escalate', { id: args.id, state: 'open', title: args.title });
  const day = nowIso().slice(0, 10);
  const file = join(p.morning, `${day}.md`);
  mkdirSync(p.morning, { recursive: true });
  if (!existsSync(file)) appendFileSync(file, `# OpenCode conductor cockpit ${day}\n`);
  appendFileSync(file, `\n## ${args.id}\n- title: ${args.title}\n- why: ${args.why}\n- commits him to: ${args.do}\n- risk if wrong: ${args.risk}\n`);
  console.log(`escalated ${args.id} -> cockpit ${file}`);
  process.exit(0);
}

if (cmd === 'inbox') {
  if (args.all !== '' && args.all !== undefined && args.all !== 'all') fail('only --all is supported', 2);
  // Latest line per escalation id wins (same carrier rule as the Claude inbox, D6/D8).
  const state = {};
  for (const line of readJsonl(p.actions)) {
    if (line.action === 'escalate') state[line.id] = line.state || 'open';
    else if (line.action === 'inbox' && line.id in state) state[line.id] = 'inboxed';
  }
  const open = Object.entries(state).filter(([, s]) => s === 'open').map(([id]) => id);
  if (!open.length) { console.log('no open escalations'); process.exit(0); }
  mkdirSync(p.state, { recursive: true });
  for (const id of open) {
    appendJsonl(p.inbox, { at: nowIso(), id, source: 'opencode-conductor' });
    logAction('inbox', { id, state: 'inboxed' });
  }
  console.log(`inboxed ${open.length} escalation(s) for the next 09:00 desk`);
  process.exit(0);
}

if (cmd === 'decide') {
  requireFlags(['id', 'topic', 'quote', 'gloss']);
  appendJsonl(p.decisions, { at: nowIso(), id: args.id, topic: args.topic, quote: args.quote, gloss: args.gloss, by: self });
  logAction('decide', { id: args.id, topic: args.topic });
  console.log(`decision ${args.id} recorded (his verbatim words)`);
  process.exit(0);
}

if (cmd === 'relay') {
  requireFlags(['decision']);
  if (!/^[A-Za-z0-9:_.-]+$/.test(args.decision)) fail('decision id may only contain ids and slugs');
  const hits = readJsonl(p.decisions).filter((d) => d.id === args.decision);
  if (!hits.length) { console.error(`no decision ${args.decision} in decisions.jsonl`); process.exit(4); }
  const d = hits[hits.length - 1];
  logAction('relay', { decision: d.id, to: args.to || null });
  console.log(`relay authorized for decision ${d.id}; send this text with send.mjs --to <session>:\n${d.quote}\n(${d.gloss})`);
  process.exit(0);
}

if (cmd === 'flag') {
  requireFlags(['line']);
  logAction('flag', { line: args.line });
  console.log('drift flag logged');
  process.exit(0);
}

if (cmd === 'unblock') {
  requireFlags(['blocker', 'owner']);
  logAction('unblock', { blocker: args.blocker, owner: args.owner });
  console.log("unblock logged (the fix itself is ordinary work under the blocker repo's rules)");
  process.exit(0);
}
