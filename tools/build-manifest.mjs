#!/usr/bin/env node
// build-manifest.mjs (maintainer only): writes manifest.json with a sha256 for every pack file, then signs it
// into manifest.sig with the release PRIVATE key (never in this repo): GADS_SIGN_KEY=<path to ed25519 key .pem>.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const PACK = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = {};
const walk = (d) => { for (const n of fs.readdirSync(d)) { if (n === '.git' || n === 'manifest.json' || n === 'manifest.sig' || n === 'node_modules') continue; const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : (files[path.relative(PACK, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')); } };
walk(PACK);
const version = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
const body = JSON.stringify({ version, built: new Date().toISOString(), files }, null, 1) + '\n';
const keyPath = process.env.GADS_SIGN_KEY;
if (!keyPath) { console.error('GADS_SIGN_KEY (path to the release private key) is required to sign.'); process.exit(2); }
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (pub.trim() !== fs.readFileSync(path.join(PACK, 'release-key.pub'), 'utf8').trim()) { console.error('That key does not match release-key.pub.'); process.exit(2); }
fs.writeFileSync(path.join(PACK, 'manifest.json'), body);
fs.writeFileSync(path.join(PACK, 'manifest.sig'), crypto.sign(null, Buffer.from(body), key).toString('base64') + '\n');
console.log(`manifest ${version}: ${Object.keys(files).length} files, signed`);
