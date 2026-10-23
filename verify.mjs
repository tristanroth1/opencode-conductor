#!/usr/bin/env node
// verify.mjs: the conductor's ONLY evidence-verification surface. In the
// confined profile (profile/opencode.jsonc) shell is denied except the lane
// scripts, so raw git/gh is not available to a talked-into conductor; this
// script wraps exactly two read-only gh operations with strict argument
// validation and no shell string (execFileSync, argv array). Anything else
// is refused before gh ever runs.
//
// Usage:
//   node verify.mjs pr <number> --repo <owner/name>
//   node verify.mjs commit <sha> --repo <owner/name>
// Exit: 0 verified (gh output printed), 2 usage/validation refused, 4 gh failed.

import { execFileSync } from 'node:child_process';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const NUM = /^\d{1,7}$/;

export function run(argv, deps = {}) {
  const exec = deps.exec || ((file, args) => execFileSync(file, args, { encoding: 'utf8' }));
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = argv[++i];
    else rest.push(argv[i]);
  }
  const cmd = rest[0];
  const val = rest[1];
  if (rest.length !== 2) return { ok: false, code: 2, why: 'usage: verify.mjs pr <number> --repo <o/n> | commit <sha> --repo <o/n>' };
  if (!args.repo || !REPO.test(args.repo)) return { ok: false, code: 2, why: '--repo <owner/name> is required (letters, digits, . _ - / only)' };

  let ghArgs;
  if (cmd === 'pr') {
    if (!NUM.test(val)) return { ok: false, code: 2, why: 'pr number must be digits only' };
    ghArgs = ['pr', 'view', val, '--repo', args.repo, '--json', 'number,title,url,state,mergedAt,headRefName,baseRefName'];
  } else if (cmd === 'commit') {
    if (!SHA.test(val)) return { ok: false, code: 2, why: 'commit must be a sha (7-40 hex characters)' };
    ghArgs = ['api', `repos/${args.repo}/commits/${val}`];
  } else {
    return { ok: false, code: 2, why: `unknown check "${cmd}": only pr and commit exist` };
  }
  // Fixed argv, no shell string: nothing validated above can inject a flag
  // or a command into what gh runs.
  try {
    return { ok: true, out: exec('gh', ghArgs) };
  } catch (e) {
    return { ok: false, code: 4, why: `gh failed: ${(e.stderr || e.message || '').split('\n')[0]}` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = run(process.argv.slice(2));
  if (!r.ok) { console.error(`refused: ${r.why}`); process.exit(r.code); }
  console.log(r.out);
  process.exit(0);
}
