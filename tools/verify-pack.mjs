#!/usr/bin/env node
// verify-pack.mjs: checks this pack is whole and genuine. manifest.json must carry a valid signature
// (manifest.sig) from the release key in release-key.pub, every file must match its sha256 in the
// manifest, no extra files may exist, and every script must parse. Exit 0 = good.
// Also exports checkRelease(), which "pack.mjs update" runs with the CURRENTLY installed key on a
// downloaded version BEFORE switching to it.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UNSIGNED = new Set(['manifest.json', 'manifest.sig']);

// read(rel) -> Buffer|null, list() -> [{ rel, mode }] for every entry in the candidate tree. pubPem = the key we trust.
// Only plain files are allowed (git mode 100644/100755): no symlinks, no submodules.
export function checkRelease({ read, list, pubPem }) {
  const problems = [];
  const man = read('manifest.json'), sig = read('manifest.sig');
  if (!man || !sig) return { ok: false, problems: ['manifest.json or manifest.sig missing'] };
  let good = false;
  try { good = crypto.verify(null, man, crypto.createPublicKey(pubPem), Buffer.from(sig.toString('utf8').trim(), 'base64')); } catch {}
  if (!good) return { ok: false, problems: ['manifest signature is NOT valid for the trusted release key'] };
  const m = JSON.parse(man.toString('utf8'));
  for (const [rel, h] of Object.entries(m.files || {})) {
    const b = read(rel);
    if (!b || crypto.createHash('sha256').update(b).digest('hex') !== h) problems.push('BAD ' + rel);
  }
  for (const { rel, mode } of list()) {
    if (mode !== '100644' && mode !== '100755') problems.push('NOT A PLAIN FILE ' + rel);
    else if (!UNSIGNED.has(rel) && !Object.hasOwn(m.files || {}, rel)) problems.push('EXTRA ' + rel);
  }
  if (!m.built || !m.version) problems.push('manifest has no version or build time');
  // Two names that differ only by upper/lower case would overwrite each other on Mac and Windows.
  const seen = new Map();
  for (const { rel } of list()) { const k = rel.toLowerCase(); if (seen.has(k)) problems.push('CASE CLASH ' + rel + ' / ' + seen.get(k)); seen.set(k, rel); }
  return { ok: problems.length === 0, problems, manifest: m };
}

function walk(d, out = []) {
  for (const n of fs.readdirSync(d)) {
    if (n === '.git' || n === 'node_modules' || n === '.DS_Store' || n === 'Thumbs.db' || n === 'desktop.ini' || n.endsWith('.tmp')) continue;
    const p = path.join(d, n), st = fs.lstatSync(p), rel = path.relative(PACK, p).split(path.sep).join('/');
    if (st.isSymbolicLink()) out.push({ rel, mode: '120000' }); else if (st.isDirectory()) walk(p, out); else out.push({ rel, mode: '100644' });
  }
  return out;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const read = (rel) => { try { return fs.readFileSync(path.join(PACK, rel)); } catch { return null; } };
  const tracked = () => {
    const g = spawnSync('git', ['-C', PACK, 'ls-files', '-s'], { encoding: 'utf8' });
    if (g.status !== 0 || !fs.existsSync(path.join(PACK, '.git'))) return walk(PACK);
    const out = g.stdout.split('\n').filter(Boolean).map((l) => { const [meta, rel] = l.split('\t'); return { rel, mode: meta.split(' ')[0] }; });
    // a tracked path must be a real file on disk, not a symlink
    for (const e of out) { try { if (fs.lstatSync(path.join(PACK, e.rel)).isSymbolicLink()) e.mode = '120000'; } catch {} }
    return out;
  };
  const r = checkRelease({ read, list: tracked, pubPem: fs.readFileSync(path.join(PACK, 'release-key.pub'), 'utf8') });
  let bad = r.problems.length;
  r.problems.forEach((p) => console.log(p));
  if (r.ok) for (const rel of Object.keys(r.manifest.files)) if (rel.endsWith('.mjs')) {
    const c = spawnSync(process.execPath, ['--check', path.join(PACK, rel)], { encoding: 'utf8' }); if (c.status !== 0) { console.log('BROKEN ' + rel); bad++; }
  }
  console.log(bad ? `FAIL ${bad} problem(s)` : `PASS ${Object.keys(r.manifest.files).length} files, signed, version ${r.manifest.version}`);
  process.exit(bad ? 1 : 0);
}
