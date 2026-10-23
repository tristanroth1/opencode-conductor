#!/usr/bin/env node
// Shared helpers for opencode-conductor (DESIGN.md).
//
// Transport is the OpenCode background service API (`opencode api`, documented in
// its /openapi.json): one shared service owns every OpenCode session on the
// machine, so sessions can address each other through it. This module wraps it
// read-only plus one documented delivery endpoint.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONDUCTOR_TITLE = 'conductor-oc';

// State (lock, kill switch, pause, reports) and logs (actions, decisions) live
// outside any repo by default. Override with OPENCODE_CONDUCTOR_STATE /
// OPENCODE_CONDUCTOR_LOGS (the tests use both).
export function paths(env = process.env) {
  const state = env.OPENCODE_CONDUCTOR_STATE || join(homedir(), '.config', 'opencode-conductor');
  const logs = env.OPENCODE_CONDUCTOR_LOGS || join(homedir(), '.local', 'state', 'opencode-conductor');
  return {
    state,
    lockDir: join(state, 'lock'),
    killSwitch: join(state, 'DISABLED'),
    pauseFile: join(state, 'PAUSED'),
    presence: join(state, 'presence.json'),
    reports: join(state, 'reports.jsonl'), // may carry private report text
    sends: join(state, 'sends.jsonl'), // metadata only, never message text
    actions: join(logs, 'actions.jsonl'),
    decisions: join(logs, 'decisions.jsonl'),
    inbox: join(logs, 'inbox.jsonl'),
    morning: join(logs, 'morning'),
    topics: join(logs, 'topics.json'),
  };
}

export function nowIso() {
  return new Date().toISOString();
}

// ---- process + session identity -------------------------------------------

// My own OpenCode session id, injected by the harness into tool shells.
export function ownSessionId(env = process.env) {
  return env.OPENCODE_SESSION_ID || null;
}

// ---- service API (read + deliver) ------------------------------------------

// Every call goes through the `opencode api` CLI, which finds the background
// service itself. No ports, no sockets, nothing to configure.
export function api(method, path, body = null, env = process.env, params = null) {
  const args = ['api'];
  if (method === 'GET') args.push('get', path);
  else args.push(method.toLowerCase(), path);
  if (body !== null) args.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
  for (const [k, v] of Object.entries(params || {})) args.push('--param', `${k}=${v}`);
  const out = execFileSync('opencode', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  const trimmed = out.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

// The CLI wraps responses as {data: ...} (often with a cursor next to it).
export function unwrap(res) {
  if (res && typeof res === 'object' && !Array.isArray(res) && 'data' in res) return res.data;
  return res;
}

// All sessions: [{id, title, directory, cost, updated, running}]. Follows the
// list cursor (the response's cursor.next token, up to 20 pages); stops on a
// null token or a repeated token, never truncates an overlapping page.
export function listSessions(env = process.env, deps = {}) {
  const call = deps.api || api;
  const rows = [];
  const seenIds = new Set();
  const seenTokens = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const params = { limit: 500 };
    if (cursor) params.cursor = cursor;
    const res = call('GET', '/api/session', null, env, params);
    const data = unwrap(res);
    const arr = Array.isArray(data) ? data : [];
    for (const s of arr) if (!seenIds.has(s.id)) { seenIds.add(s.id); rows.push(s); }
    const next = (res && typeof res === 'object' && !Array.isArray(res) && res.cursor && res.cursor.next) || null;
    if (!next || seenTokens.has(next)) break;
    seenTokens.add(next);
    cursor = next;
  }
  let active = new Set();
  try {
    const a = unwrap(call('GET', '/api/session/active', null, env)) || {};
    active = new Set(Object.keys(a));
  } catch { /* active list is an optimisation, not a requirement */ }
  return rows.map((s) => ({
    id: s.id,
    title: s.title || '',
    directory: (s.location && s.location.directory) || s.directory || '',
    cost: s.cost ?? null,
    updated: s.time && s.time.updated ? new Date(s.time.updated).toISOString() : null,
    running: active.has(s.id),
  }));
}

// Resolve a target: exact session id first, then exact title among running
// sessions, then exact title among all sessions (queued delivery to an idle
// session is durable in its inbox).
export function resolveTarget(ref, env = process.env, deps = {}) {
  const sessions = deps.sessions ? deps.sessions() : listSessions(env, deps);
  const byId = sessions.find((s) => s.id === ref);
  if (byId) return { ...byId, queued: !byId.running };
  const running = sessions.find((s) => s.running && s.title === ref);
  if (running) return { ...running, queued: false };
  const any = sessions.find((s) => s.title === ref);
  if (any) return { ...any, queued: true };
  return null;
}

// Is this session live right now (TUI process attached)? Three states: the
// service's active list is authoritative for 'active'/'inactive', but a service
// error is 'unknown' and every safety-relevant caller treats unknown as
// fail-closed (the lock is never stolen or dropped on a blind spot).
export function sessionActiveState(sid, env = process.env, deps = {}) {
  if (!sid) return 'inactive';
  if (deps.activeState) return deps.activeState(sid);
  try {
    const a = unwrap(api('GET', '/api/session/active', null, env)) || {};
    return a[sid] ? 'active' : 'inactive';
  } catch { return 'unknown'; }
}

// Boolean convenience for non-safety-critical paths (listings, self-marks).
// (Kept exported: the sweep uses the three-state form; this stays for future
// non-lock callers.)
export function isSessionActive(sid, env = process.env, deps = {}) {
  return sessionActiveState(sid, env, deps) === 'active';
}

// ---- guard checks -----------------------------------------------------------

export function guardRead(p) {
  // Reads always work, even paused or disabled: list-only mode needs them.
  return { ok: true, paused: existsSync(p.pauseFile), disabled: existsSync(p.killSwitch) };
}

export function guardWrite(p) {
  if (existsSync(p.killSwitch)) return { ok: false, why: 'kill switch present (DISABLED): every action refuses' };
  if (existsSync(p.pauseFile)) return { ok: false, why: 'paused (list-only): say "go" in the conductor window first' };
  return { ok: true };
}

// ---- logs --------------------------------------------------------------------

export function appendJsonl(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n');
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

export function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  appendFileSync(tmp, JSON.stringify(value) + '\n');
  try { renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
