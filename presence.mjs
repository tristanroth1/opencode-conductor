#!/usr/bin/env node
// presence.mjs (OpenCode lane): here / away state and the back digest.
// Simplified from the Claude conductor's presence.mjs: this lane has no closes,
// so the digest counts relays, unblocks, escalations and decisions waiting.
//
// Usage:
//   node presence.mjs get
//   node presence.mjs here
//   node presence.mjs away [--for 3h]
//   node presence.mjs back      digest when leaving away

import { existsSync } from 'node:fs';
import { nowIso, paths, readJson, readJsonl, writeJson } from './lib.mjs';

const p = paths();
const cmd = process.argv[2];

function plusIso(hours) {
  // "away --for 3h": until is in the FUTURE.
  const m = String(hours || '').match(/^([\d.]+)h?$/);
  if (!m) return null;
  return new Date(Date.now() + Number(m[1]) * 3600 * 1000).toISOString();
}

if (cmd === 'get' || !cmd) {
  const s = readJson(p.presence) || { mode: 'here', since: nowIso() };
  console.log(JSON.stringify(s));
  process.exit(0);
}

if (cmd === 'here' || cmd === 'away') {
  const prev = readJson(p.presence) || {};
  const forIdx = process.argv.indexOf('--for');
  const hours = forIdx !== -1 ? process.argv[forIdx + 1] : null;
  const until = cmd === 'away' ? plusIso(hours) : null;
  const state = { mode: cmd, since: nowIso(), until };
  writeJson(p.presence, state);
  console.log(JSON.stringify({ ...state, previous: prev.mode || null }));
  process.exit(0);
}

if (cmd === 'back') {
  const s = readJson(p.presence) || {};
  if (s.mode !== 'away') { console.log('was not away'); process.exit(0); }
  const since = s.since;
  const counts = { relayed: 0, unblocked: 0, escalated: 0, decided: 0, inboxed: 0 };
  const waiting = [];
  const latest = {};
  for (const line of readJsonl(p.actions)) {
    if (since && line.at < since) continue;
    latest[line.id || line.action + ':' + (line.at || '')] = line;
  }
  for (const line of Object.values(latest)) {
    if (line.action === 'relay' || line.action === 'continue') counts.relayed++;
    else if (line.action === 'unblock') counts.unblocked++;
    else if (line.action === 'escalate') { if ((line.state || 'open') === 'open') { counts.escalated++; waiting.push(line.id); } }
    else if (line.action === 'inbox') counts.inboxed++;
  }
  for (const d of readJsonl(p.decisions)) { if (!since || d.at >= since) counts.decided++; }
  console.log(JSON.stringify({ awaySince: since, back: nowIso(), ...counts, waiting }, null, 1));
  process.exit(0);
}

console.error('usage: presence.mjs get | here | away [--for 3h] | back');
process.exit(2);
