#!/usr/bin/env node
// Conductor singleton (DESIGN.md). Atomic mkdir lock plus a lifetime holder
// process, with
// one difference: an OpenCode session has no pid registry, so the owner identity
// is the session id (OPENCODE_SESSION_ID) and liveness is the background
// service's active list. Deleting the lock dir never admits a second conductor
// while the first session is still live.
//
// Usage:
//   node lock.mjs acquire [--session-id S] [--logs DIR]
//   node lock.mjs status
//   node lock.mjs release
// Env OPENCODE_CONDUCTOR_NO_HOLDER=1 skips the holder process (tests only).
// Exit: 0 ok, 3 refused (another conductor is live), 2 usage.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDUCTOR_TITLE, nowIso, paths, readJson, sessionActiveState } from './lib.mjs';

export const MARKER = 'fleet-opencode-conductor-lock-holder';
const SELF = fileURLToPath(import.meta.url);

function readOwner(p) {
  try { return JSON.parse(readFileSync(join(p.lockDir, 'owner.json'), 'utf8')); } catch { return null; }
}

// Liveness of the lock owner: 'active' | 'inactive' | 'unknown' (fail-closed).
function ownerState(p, env, deps) {
  const owner = readOwner(p);
  if (!owner || !owner.session_id) return 'inactive';
  return deps.activeState ? deps.activeState(owner.session_id) : sessionActiveState(owner.session_id, env, deps);
}

// Live holder processes watching this state dir.
export function liveHolders(p) {
  let out = '';
  try { out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.includes(MARKER)) continue;
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const st = m[2].match(/--state (.+)$/);
    if (!st || st[1].trim() !== p.state) continue;
    rows.push({ pid: Number(m[1]), session: (m[2].match(/--session (\S+)/) || [])[1] || null });
  }
  return rows;
}

export function status(env = process.env, deps = {}) {
  const p = paths(env);
  const owner = readOwner(p);
  const state = ownerState(p, env, deps);
  const holders = liveHolders(p);
  return {
    held: state !== 'inactive' || holders.length > 0,
    ownerState: state,
    owner: state === 'active' ? owner : null,
    holders,
    lockDir: p.lockDir,
    paused: existsSync(p.pauseFile),
    disabled: existsSync(p.killSwitch),
  };
}

// Publish the lock dir with owner.json already inside (rename is atomic). When
// the lock is held, rename fails with EEXIST/ENOTEMPTY: the caller decides
// (reentrant, refused, or stale reclaim). Never delete an existing lock here.
function publish(p, owner) {
  const tmpDir = `${p.lockDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'owner.json'), JSON.stringify(owner) + '\n');
  try { renameSync(tmpDir, p.lockDir); } catch (e) { rmSync(tmpDir, { recursive: true, force: true }); throw e; }
}

function startHolder(p, owner) {
  const child = spawn(process.execPath, [SELF, 'hold', MARKER, '--session', owner.session_id, '--state', p.state],
    { detached: true, stdio: 'ignore', env: { ...process.env, OPENCODE_CONDUCTOR_STATE: p.state } });
  child.unref();
  return child.pid;
}

export function acquire({ sessionId = null } = {}, env = process.env, deps = {}) {
  const p = paths(env);
  const sid = sessionId || (env.OPENCODE_SESSION_ID || null);
  if (!sid) return { ok: false, code: 2, reason: 'no session id: OPENCODE_SESSION_ID is not set and --session-id was not given' };
  // Fail closed on a broken process table: rival-holder detection depends on it.
  try { execFileSync('ps', ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' }); } catch {
    return { ok: false, code: 3, reason: 'cannot read the process table (ps failed); not acquiring the conductor lock' };
  }
  mkdirSync(p.state, { recursive: true });
  const stateOf = deps.activeState ? deps.activeState : (s) => sessionActiveState(s, env, deps);
  const self = (h) => h.session === sid;
  const other = liveHolders(p).find((h) => !self(h));
  if (other) {
    const o = readOwner(p) || {};
    return { ok: false, code: 3, reason: `OpenCode conductor already live: session ${other.session}${o.session_id && o.session_id !== other.session ? ` (owner.json: ${o.session_id})` : ''}` };
  }
  const owner = { session_id: sid, title: CONDUCTOR_TITLE, at: nowIso() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { publish(p, owner); } catch (e) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(e.code)) throw e;
      const o = readOwner(p);
      const st = o ? stateOf(o.session_id) : 'inactive';
      if (st === 'unknown') return { ok: false, code: 3, reason: 'a lock exists but its liveness cannot be verified (service unreachable); not stealing it. Retry when the service answers' };
      if (st === 'active') {
        if (o.session_id === sid) return { ok: true, code: 0, reentrant: true, owner: o };
        return { ok: false, code: 3, reason: `OpenCode conductor already live: session ${o.session_id} (${o.title || CONDUCTOR_TITLE})` };
      }
      // Stale (owner session confirmed gone): move it aside atomically; a rival doing the same re-reads.
      const aside = `${p.lockDir}.stale-${Date.now()}-${process.pid}`;
      try { renameSync(p.lockDir, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* a rival moved it */ }
      continue;
    }
    if (!env.OPENCODE_CONDUCTOR_NO_HOLDER && !liveHolders(p).some(self)) startHolder(p, owner);
    const rival = liveHolders(p).find((h) => !self(h));
    if (rival) { release(env, deps); return { ok: false, code: 3, reason: `OpenCode conductor already live: session ${rival.session}` }; }
    return { ok: true, code: 0, owner };
  }
  return { ok: false, code: 3, reason: 'lock contention' };
}

export function release(env = process.env, deps = {}) {
  const p = paths(env);
  const o = readOwner(p);
  if (o && o.session_id && o.session_id !== (env.OPENCODE_SESSION_ID || '') && sessionActiveState(o.session_id, env, deps) !== 'inactive') {
    return { ok: false, reason: `held by session ${o.session_id}` };
  }
  for (const h of liveHolders(p)) {
    if (!o || h.session === o.session_id || sessionActiveState(h.session, env, deps) === 'inactive') {
      try { process.kill(h.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  rmSync(p.lockDir, { recursive: true, force: true });
  return { ok: true };
}

// One tick of the holder, exported for tests. Fail-safe on 'unknown': keep
// holding and heal the lock dir, never drop it on a blind spot. Only a
// CONFIRMED inactive owner cleans up and exits.
export function holdTick(sid, p, deps = {}) {
  const state = deps.activeState ? deps.activeState(sid) : sessionActiveState(sid);
  if (state === 'unknown') { heal(p, sid); return 'held'; }
  if (state === 'inactive') {
    const o = readOwner(p);
    if (!o || o.session_id === sid) rmSync(p.lockDir, { recursive: true, force: true });
    return 'exit';
  }
  heal(p, sid);
  return 'held';
}

function heal(p, sid) {
  if (!existsSync(p.lockDir)) {
    try { publish(p, { session_id: sid, title: CONDUCTOR_TITLE, healed_at: nowIso() }); } catch { /* exists: fine */ }
  }
}

// The holder lives exactly as long as the owner session is active.
function hold(args) {
  const sid = args.session;
  const p = paths({ ...process.env, OPENCODE_CONDUCTOR_STATE: args.state });
  const tick = () => { if (holdTick(sid, p) === 'exit') process.exit(0); };
  tick();
  setInterval(tick, Number(process.env.OPENCODE_CONDUCTOR_HOLD_TICK_MS || 5000));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = {};
  const rest = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1] || true;
    else rest.push(process.argv[i]);
  }
  const cmd = rest[0];
  if (cmd === 'hold') hold(args);
  else if (cmd === 'acquire') {
    const r = acquire({ sessionId: args['session-id'] || null });
    console.log(JSON.stringify(r));
    process.exit(r.code);
  } else if (cmd === 'status') {
    console.log(JSON.stringify(status()));
  } else if (cmd === 'release') {
    const r = release();
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 3);
  } else {
    console.error('usage: lock.mjs acquire|status|release [--session-id S]');
    process.exit(2);
  }
}
