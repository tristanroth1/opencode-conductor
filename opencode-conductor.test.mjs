#!/usr/bin/env node
// Tests for opencode-conductor.
// Run: node --test opencode-conductor.test.mjs
// Hermetic except two marked live read-only checks: every test gets its own tmp
// state dir, liveness is injected, and the only service touches are read-only
// GETs (the two "live" tests) or none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_SESSION = process.env.OPENCODE_SESSION_ID || null;

function tmpState(name) {
  const dir = mkdtempSync(join(tmpdir(), `oc-conductor-${name}-`));
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  // NO_HOLDER: acquire() must never spawn a real detached holder in tests. A
  // real holder asks the live service about fake session ids; when the service
  // answers 'inactive' it deletes the lock and the reentrant test fails. The
  // holder's logic is covered directly by the holdTick test below.
  return { dir, logs, env: { ...process.env, OPENCODE_CONDUCTOR_STATE: join(dir, 'state'), OPENCODE_CONDUCTOR_LOGS: logs, OPENCODE_CONDUCTOR_NO_HOLDER: '1' } };
}

function holdLock(t, sid) {
  const lockDir = join(t.dir, 'state', 'lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ session_id: sid }));
}

function runCli(file, args, env) {
  return spawnSync(process.execPath, [join(HERE, file), ...args], { env, encoding: 'utf8' });
}

// ---- lib: session list + resolve (injected API, no live calls) --------------

test('listSessions joins the session list with the active set', async () => {
  const { listSessions } = await import('./lib.mjs');
  const calls = [];
  const fakeApi = (method, path) => {
    calls.push(`${method} ${path}`);
    if (path === '/api/session') return { data: [
      { id: 'ses_a', title: 'night lane', location: { directory: '/home/dev/project' }, cost: 0.5, time: { updated: 1792712428522 } },
      { id: 'ses_b', title: 'done lane', location: { directory: '/home/dev' }, cost: 0, time: { updated: 1792712000000 } },
    ] };
    if (path === '/api/session/active') return { data: { ses_a: { type: 'running' } } };
    throw new Error('unexpected ' + path);
  };
  const rows = listSessions(process.env, { api: fakeApi });
  assert.deepEqual(calls, ['GET /api/session', 'GET /api/session/active']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].directory, '/home/dev/project');
  assert.equal(rows[1].running, false);
});

test('listSessions follows cursor tokens, never duplicates, stops on a repeated token', async () => {
  const { listSessions } = await import('./lib.mjs');
  const pages = [
    { data: [{ id: 'ses_a', title: 'a' }], cursor: { next: 'tok1' } },
    { data: [{ id: 'ses_a', title: 'a' }, { id: 'ses_b', title: 'b' }], cursor: { next: 'tok1' } }, // token repeats: stop after this page
  ];
  let n = 0;
  const fakeApi = (method, path) => {
    if (path === '/api/session/active') return { data: {} };
    return pages[n++] ?? { data: [] };
  };
  const rows = listSessions(process.env, { api: fakeApi });
  assert.equal(n, 2); // stopped at the repeated token, no infinite loop
  assert.deepEqual(rows.map((r) => r.id), ['ses_a', 'ses_b']);
});

test('resolveTarget prefers running title match and marks queued when idle', async () => {
  const { resolveTarget } = await import('./lib.mjs');
  const sessions = () => [
    { id: 'ses_a', title: 'conductor-oc', running: true },
    { id: 'ses_b', title: 'conductor-oc', running: false },
    { id: 'ses_c', title: 'worker', running: false },
  ];
  assert.equal(resolveTarget('conductor-oc', process.env, { sessions }).id, 'ses_a');
  assert.equal(resolveTarget('worker', process.env, { sessions }).id, 'ses_c');
  assert.equal(resolveTarget('worker', process.env, { sessions }).queued, true);
  assert.equal(resolveTarget('ses_b', process.env, { sessions }).id, 'ses_b');
  assert.equal(resolveTarget('nope', process.env, { sessions }), null);
});

// ---- lock: singleton with injected liveness (I1/I12 equivalents) ------------

test('lock: second conductor refused while the first is live; stale lock reclaimed', async () => {
  const { acquire, release } = await import('./lock.mjs');
  const t = tmpState('lock');
  try {
    const active = new Set(['ses_live_a']);
    const deps = { activeState: (s) => (active.has(s) ? 'active' : 'inactive') };
    const a = acquire({ sessionId: 'ses_live_a' }, t.env, deps);
    assert.equal(a.ok, true, JSON.stringify(a));
    // reentrant for the same session
    const again = acquire({ sessionId: 'ses_live_a' }, t.env, deps);
    assert.equal(again.ok, true);
    assert.equal(again.reentrant, true);
    // a different session is refused (exit 3 semantics)
    const b = acquire({ sessionId: 'ses_live_b' }, t.env, deps);
    assert.equal(b.ok, false);
    assert.equal(b.code, 3);
    // the owner going away makes the lock stale: a new conductor takes over
    active.delete('ses_live_a');
    const c = acquire({ sessionId: 'ses_live_c' }, t.env, deps);
    assert.equal(c.ok, true, JSON.stringify(c));
    const rel = release(t.env, deps);
    assert.equal(rel.ok, true, JSON.stringify(rel));
    rmSync(join(t.env.OPENCODE_CONDUCTOR_STATE, 'lock'), { recursive: true, force: true });
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('lock: an unverifiable owner (service unreachable) is never stolen (fail-closed)', async () => {
  const { acquire } = await import('./lock.mjs');
  const t = tmpState('lock-unknown');
  try {
    const deps = { activeState: () => 'unknown' };
    // first acquire cannot confirm its own publish either when a lock exists
    holdLock(t, 'ses_someone');
    const r = acquire({ sessionId: 'ses_me' }, t.env, deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.match(r.reason, /cannot be verified|unreachable/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('lock: no session id is a usage error', async () => {
  const { acquire } = await import('./lock.mjs');
  const t = tmpState('lock-noid');
  try {
    const r = acquire({}, { ...t.env, OPENCODE_SESSION_ID: '' }, { activeState: () => 'inactive' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 2);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('holder tick: heals a deleted lock, holds on unknown, exits only when confirmed inactive', async () => {
  const { holdTick } = await import('./lock.mjs');
  const t = tmpState('hold');
  try {
    const p = { lockDir: join(t.dir, 'state', 'lock') };
    const active = { activeState: () => 'active' };
    assert.equal(holdTick('ses_x', p, active), 'held');
    assert.equal(existsSync(join(p.lockDir, 'owner.json')), true); // healed
    rmSync(p.lockDir, { recursive: true, force: true });
    assert.equal(holdTick('ses_x', p, active), 'held');
    assert.equal(existsSync(join(p.lockDir, 'owner.json')), true); // healed again
    const unknown = { activeState: () => 'unknown' };
    rmSync(p.lockDir, { recursive: true, force: true });
    assert.equal(holdTick('ses_x', p, unknown), 'held'); // blind spot: hold, do not drop
    assert.equal(existsSync(join(p.lockDir, 'owner.json')), true); // healing on unknown is the fail-safe direction: a kept lock is reclaimable later, a dropped lock admits a rival now
    const inactive = { activeState: () => 'inactive' };
    holdLock(t, 'ses_x');
    assert.equal(holdTick('ses_x', p, inactive), 'exit');
    assert.equal(existsSync(p.lockDir), false);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

// ---- act.mjs CLI: guards (kill switch, pause, lock, close refusal) ----------

test('act close is refused unconditionally (exit 6)', () => {
  const t = tmpState('close');
  try {
    const r = runCli('act.mjs', ['close', '--session', 'ses_x'], t.env);
    assert.equal(r.status, 6);
    assert.match(r.stderr, /never closes windows/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act write refuses on kill switch (I11 equivalent)', () => {
  const t = tmpState('kill');
  try {
    mkdirSync(join(t.dir, 'state'), { recursive: true });
    writeFileSync(join(t.dir, 'state', 'DISABLED'), 'x');
    const r = runCli('act.mjs', ['escalate', '--id', 't1', '--title', 'T', '--why', 'w', '--do', 'd', '--risk', 'r'], t.env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /kill switch/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act write refuses while paused (list-only mode)', () => {
  const t = tmpState('pause');
  try {
    mkdirSync(join(t.dir, 'state'), { recursive: true });
    writeFileSync(join(t.dir, 'state', 'PAUSED'), 'initial');
    const r = runCli('act.mjs', ['escalate', '--id', 't1', '--title', 'T', '--why', 'w', '--do', 'd', '--risk', 'r'], t.env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /paused|list-only/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act write refuses without the conductor lock', () => {
  const t = tmpState('nolock');
  try {
    const r = runCli('act.mjs', ['flag', '--line', 'drift test'], t.env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no conductor lock/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act write refuses when another session holds the lock', () => {
  const t = tmpState('otherlock');
  try {
    holdLock(t, 'ses_other');
    const env = { ...t.env, OPENCODE_SESSION_ID: 'ses_me' };
    const r = runCli('act.mjs', ['flag', '--line', 'drift test'], env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /lock held by session ses_other/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act write refuses a caller with no session identity (cron or random shell)', () => {
  const t = tmpState('noid');
  try {
    holdLock(t, 'ses_other');
    const env = { ...t.env, OPENCODE_SESSION_ID: '' };
    const r = runCli('act.mjs', ['flag', '--line', 'drift test'], env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no OPENCODE_SESSION_ID/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act escalate + report(file) + decide + relay + inbox round trip with lock held', () => {
  const t = tmpState('roundtrip');
  try {
    holdLock(t, 'ses_me');
    const env = { ...t.env, OPENCODE_SESSION_ID: 'ses_me' };
    const e = runCli('act.mjs', ['escalate', '--id', 'oc:test-1', '--title', 'Pick A or B', '--why', 'both valid', '--do', 'A', '--risk', 'one line'], env);
    assert.equal(e.status, 0, e.stderr);
    const day = new Date().toISOString().slice(0, 10);
    const carrier = readFileSync(join(t.logs, 'morning', `${day}.md`), 'utf8');
    assert.match(carrier, /## oc:test-1/);
    // worker report arrives as a JSON file (never as arguments)
    const rep = join(t.dir, 'report.json');
    writeFileSync(rep, JSON.stringify({ from: 'ses_worker1', topic: 'evidence-night-847', status: 'WORK-REMAINING', evidence: 'owner/repo#N pushed', next: 'awaiting review', unsaved: 'none' }));
    const r = runCli('act.mjs', ['report', '--file', rep], env);
    assert.equal(r.status, 0, r.stderr);
    const d = runCli('act.mjs', ['decide', '--id', 'oc:test-1', '--topic', 'test topic', '--quote', 'go with A', '--gloss', 'he picked A'], env);
    assert.equal(d.status, 0, d.stderr);
    const rel = runCli('act.mjs', ['relay', '--decision', 'oc:test-1', '--to', 'ses_worker'], env);
    assert.equal(rel.status, 0, rel.stderr);
    assert.match(rel.stdout, /go with A/);
    // the escalation is still open: inbox moves it to the 09:00 carrier
    const ib = runCli('act.mjs', ['inbox', '--all'], env);
    assert.equal(ib.status, 0, ib.stderr);
    assert.match(ib.stdout, /inboxed 1/);
    assert.match(readFileSync(join(t.logs, 'inbox.jsonl'), 'utf8'), /oc:test-1/);
    // second inbox run is a no-op (latest state per id wins)
    const ib2 = runCli('act.mjs', ['inbox', '--all'], env);
    assert.match(ib2.stdout, /no open escalations/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act report validates field shapes (from id, topic charset, status enum)', () => {
  const t = tmpState('report');
  try {
    holdLock(t, 'ses_me');
    const env = { ...t.env, OPENCODE_SESSION_ID: 'ses_me' };
    const bad1 = join(t.dir, 'r1.json');
    writeFileSync(bad1, JSON.stringify({ from: 'not-a-session', topic: 'x', status: 'CLOSE' }));
    const r1 = runCli('act.mjs', ['report', '--file', bad1], env);
    assert.equal(r1.status, 3);
    assert.match(r1.stderr, /from/);
    const bad2 = join(t.dir, 'r2.json');
    writeFileSync(bad2, JSON.stringify({ from: 'ses_worker1', topic: 'topic; rm -rf /', status: 'CLOSE' }));
    const r2 = runCli('act.mjs', ['report', '--file', bad2], env);
    assert.equal(r2.status, 3);
    assert.match(r2.stderr, /topic/);
    const bad3 = join(t.dir, 'r3.json');
    writeFileSync(bad3, JSON.stringify({ from: 'ses_worker1', topic: 'ok topic', status: 'WHATEVER' }));
    const r3 = runCli('act.mjs', ['report', '--file', bad3], env);
    assert.equal(r3.status, 3);
    assert.match(r3.stderr, /status/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('act go: kill switch beats everything, then a recorded reason, then lock', () => {
  const t = tmpState('go');
  try {
    const stateDir = join(t.dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'PAUSED'), 'initial');
    const env = { ...t.env, OPENCODE_SESSION_ID: 'ses_me' };
    // kill switch first, even with a good reason and a held lock
    holdLock(t, 'ses_me');
    writeFileSync(join(stateDir, 'DISABLED'), 'x');
    const ks = runCli('act.mjs', ['go', '--reason', 'go 2026-11-01'], env);
    assert.equal(ks.status, 3);
    assert.match(ks.stderr, /kill switch/);
    rmSync(join(stateDir, 'DISABLED'));
    // a too-short reason is refused
    const bad = runCli('act.mjs', ['go', '--reason', 'ok'], env);
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /reason is required/);
    const good = runCli('act.mjs', ['go', '--reason', 'go 2026-11-01'], env);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(existsSync(join(stateDir, 'PAUSED')), false);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

// ---- send.mjs guards ---------------------------------------------------------

test('send refuses the conductor itself while paused (hermetic: no service call)', () => {
  const t = tmpState('send-paused');
  try {
    holdLock(t, SELF_SESSION || 'ses_me');
    const env = { ...t.env, OPENCODE_SESSION_ID: SELF_SESSION || 'ses_me' };
    mkdirSync(join(t.dir, 'state'), { recursive: true });
    writeFileSync(join(t.dir, 'state', 'PAUSED'), 'initial');
    const r = runCli('send.mjs', ['--to', 'ses_anyone', '--text', 'should refuse'], env);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /paused|list-only/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('send refuses self-send and unknown targets (live service, read-only GETs only)', (t0) => {
  if (!SELF_SESSION) { t0.skip('no OPENCODE_SESSION_ID in this environment'); return; }
  const t = tmpState('send-self');
  try {
    const self = runCli('send.mjs', ['--to', SELF_SESSION, '--text', 'loop test'], t.env);
    assert.equal(self.status, 5);
    assert.match(self.stderr, /own session/);
    const unknown = runCli('send.mjs', ['--to', 'ses_does_not_exist_zz', '--text', 'x'], t.env);
    assert.equal(unknown.status, 4);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

// ---- presence digest ---------------------------------------------------------

test('presence back digest counts actions since away', () => {
  const t = tmpState('presence');
  try {
    const stateDir = join(t.dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'presence.json'), JSON.stringify({ mode: 'away', since: '2020-01-01T00:00:00Z' }));
    const logs = join(t.logs);
    writeFileSync(join(logs, 'actions.jsonl'), [
      JSON.stringify({ at: '2026-01-01T00:00:00Z', action: 'relay', decision: 'd1' }),
      JSON.stringify({ at: '2026-01-01T00:01:00Z', action: 'unblock', blocker: 'b1' }),
      JSON.stringify({ at: '2026-01-01T00:02:00Z', action: 'escalate', id: 'e1', state: 'open' }),
      '',
    ].join('\n'));
    const r = runCli('presence.mjs', ['back'], t.env);
    assert.equal(r.status, 0, r.stderr);
    const digest = JSON.parse(r.stdout);
    assert.equal(digest.relayed, 1);
    assert.equal(digest.unblocked, 1);
    assert.equal(digest.escalated, 1);
    assert.deepEqual(digest.waiting, ['e1']);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('presence away --for puts until in the future', () => {
  const t = tmpState('presence-until');
  try {
    const r = runCli('presence.mjs', ['away', '--for', '3h'], t.env);
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(r.stdout);
    assert.equal(state.mode, 'away');
    assert.ok(state.until, 'until is set');
    assert.ok(new Date(state.until).getTime() > Date.now() + 2 * 3600 * 1000, `until ${state.until} is ~3h ahead`);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

// ---- verify.mjs: the confined conductor's only verification surface ----------

test('verify: pr and commit build fixed gh argv (no shell string), happy path', async () => {
  const { run } = await import('./verify.mjs');
  const seen = [];
  const exec = (file, args) => { seen.push([file, ...args]); return '{"state":"OPEN"}'; };
  const pr = run(['pr', '42', '--repo', 'acme/app'], { exec });
  assert.equal(pr.ok, true, pr.why);
  assert.deepEqual(seen[0], ['gh', 'pr', 'view', '42', '--repo', 'acme/app',
    '--json', 'number,title,url,state,mergedAt,headRefName,baseRefName']);
  const cm = run(['commit', 'a1b2c3d', '--repo', 'acme/app'], { exec });
  assert.equal(cm.ok, true, cm.why);
  assert.deepEqual(seen[1], ['gh', 'api', 'repos/acme/app/commits/a1b2c3d']);
});

test('verify: refuses injection shapes before gh ever runs', async () => {
  const { run } = await import('./verify.mjs');
  const exec = () => { throw new Error('gh must not run'); };
  const bad = [
    [['pr', '42'], 'missing --repo'],
    [['pr', '42', '--repo', 'acme/app; curl evil.sh'], 'shell chars in repo'],
    [['pr', '42', '--repo', 'acme/app --json x'], 'space-separated extra flags in repo'],
    [['pr', '../../etc', '--repo', 'acme/app'], 'non-numeric pr'],
    [['pr', '42', '--json', 'x', '--repo', 'acme/app'], 'unknown flag becomes positional'],
    [['commit', 'short', '--repo', 'acme/app'], 'bad sha'],
    [['diff', 'main', '--repo', 'acme/app'], 'unknown subcommand'],
    [['pr', '42', 'extra', '--repo', 'acme/app'], 'extra positional'],
    [[], 'no args'],
  ];
  for (const [argv, label] of bad) {
    const r = run(argv, { exec });
    assert.equal(r.ok, false, `${label} should be refused`);
    assert.equal(r.code, 2, `${label} should be a usage refusal`);
  }
});

test('verify: a gh failure is reported, exit 4, not thrown', async () => {
  const { run } = await import('./verify.mjs');
  const exec = () => { const e = new Error('boom'); e.stderr = 'GraphQL: not found'; throw e; };
  const r = run(['pr', '42', '--repo', 'acme/gone'], { exec });
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.why, /not found/);
});
