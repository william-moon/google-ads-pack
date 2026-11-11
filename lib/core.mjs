// core.mjs: shared helpers for the Google Ads Pack. No outside packages (Node 18+).
// State lives OUTSIDE the pack folder so updates never touch it:
//   $GADS_HOME (default ~/.google-ads-pack)/config.json      business settings (name, domain, ids)
//   $GADS_HOME/secrets/*.json   (chmod 600)                    google.json (OAuth client + refresh token), clarity.json
//   $GADS_HOME/data/...                                         daily snapshots, logs, negatives ledger
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PACK = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const HOME = process.env.GADS_HOME || path.join(os.homedir(), '.google-ads-pack');
export const SECRETS = path.join(HOME, 'secrets');
export const DATA = path.join(HOME, 'data');
for (const d of [HOME, SECRETS, DATA]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
for (const d of [HOME, SECRETS, DATA]) { try { fs.chmodSync(d, 0o700); } catch {} }

export const argv = process.argv.slice(2);
export const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
export const has = (n) => argv.includes('--' + n);
export const die = (m, c = 2) => { console.error(m); process.exit(c); };

export function readJSON(p, d = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
export function writeJSON(p, obj, secret = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, p);
}
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const config = () => readJSON(CONFIG_PATH, {});
export function saveConfig(patch) { const c = { ...config(), ...patch }; writeJSON(CONFIG_PATH, c, true); return c; }
// Read a secret from a file (or "-" = stdin) so it never shows in the process list or shell history.
export function secretArg(name) {
  const f = arg(name + '-file');
  if (f) return (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8')).trim();
  return undefined; // never from a plain --flag (it would show in the process list and shell history)
}
export const secret = (name) => readJSON(path.join(SECRETS, name + '.json'));
export const saveSecret = (name, obj) => writeJSON(path.join(SECRETS, name + '.json'), obj, true);

export function log(name, line) {
  fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
  fs.appendFileSync(path.join(DATA, 'logs', name + '.log'), new Date().toISOString() + ' ' + line + '\n');
}
export const today = () => new Date().toISOString().slice(0, 10);
export const $ = (micros) => (Number(micros || 0) / 1e6).toFixed(2);
// Hide anything that looks like a token in text we print or log.
export const scrub = (s) => String(s).replace(/(ya29\.|1\/\/|GOCSPX-|AIza)[\w.-]+/g, '<hidden>').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<hidden>').replace(/"(refresh_token|access_token|client_secret|token)"\s*:\s*"[^"]+"/g, '"$1":"<hidden>"');

// Any error a tool does not catch ends with one clean line (no stack trace, no tokens), exit code 3 for login problems.
const bye = (e) => { console.error(scrub(e?.message || e)); process.exit(e?.exitCode || 1); };
process.on('uncaughtException', bye);
process.on('unhandledRejection', bye);
