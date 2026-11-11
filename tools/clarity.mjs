#!/usr/bin/env node
// clarity.mjs: Microsoft Clarity for one business site. Clarity keeps only the last 3 days of data,
// so run `pull` once a day (cron) to build long-term history locally and in a Google Sheet.
//
//   node tools/clarity.mjs setup                                   # the one-time owner steps (no create API exists)
//   node tools/clarity.mjs save --project <projectId> --token-file <file with the token>   (or --token-file - to read it from stdin)
//   node tools/clarity.mjs pull [--days 1] [--force]               # 3 API calls: totals, by URL, by Device
//   node tools/clarity.mjs sheet                                   # create the Google Sheet now (pull does it on its own)
//   node tools/clarity.mjs report [--days 7]                       # summary from the saved history
//
// Daily cron example (00:15 every night):
//   15 0 * * * cd /path/to/google-ads-pack && node tools/clarity.mjs pull >> "$HOME/.google-ads-pack/data/logs/clarity-cron.log" 2>&1
//
// The API token is stored in $GADS_HOME/secrets/clarity.json (chmod 600) and is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { arg, has, die, config, saveConfig, secret, saveSecret, writeJSON, readJSON, log, today, argv, DATA, secretArg } from '../lib/core.mjs';

const cmd = argv[0];
const DIR = path.join(DATA, 'clarity');
const HISTORY = path.join(DIR, 'history.csv');
const HEADER = ['date', 'dimension', 'value', 'metric', 'field', 'number'];
const API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const DAILY_CAP = 9; // Clarity allows 10 calls a day. Keep one spare.
fs.mkdirSync(DIR, { recursive: true });

function setup() {
  const c = config();
  console.log('Clarity has no API to create a project, so this is a one-time 3 minute step for the owner:');
  console.log('  1. Sign in at https://clarity.microsoft.com (a Google or Microsoft login works).');
  console.log(`  2. Click New project. Name: ${c.businessName || '<your business name>'}. Website URL: ${c.domain ? 'https://' + c.domain : '<your domain>'}.`);
  console.log('     When it asks how to install, skip it. The tag goes in through Google Tag Manager.');
  console.log('  3. Copy the Project ID: Settings > Overview (a short code like abc12de3fg).');
  console.log('  4. Settings > Data Export > Generate new API token. Give it any name and copy the token.');
  console.log('  5. Hand both to the bot, or run:');
  console.log('       node tools/clarity.mjs save --project <projectId> --token-file <file with the token>');
  console.log('  6. Run the container step again so the Clarity tag goes live, then set the daily pull:');
  console.log('       node tools/tracking.mjs container --confirm');
  console.log('       node tools/clarity.mjs pull   (first snapshot; then once a day by cron)');
  if (c.clarityProjectId) console.log(`\nAlready saved: project ${c.clarityProjectId}${secret('clarity')?.token ? ' with an API token' : ' (no API token yet)'}.`);
}

function save() {
  const project = String(arg('project', '')).trim();
  const token = String(secretArg('token') || '').trim();
  if (!/^[a-z0-9]{6,20}$/i.test(project)) die('Need --project <projectId> (letters and numbers, from Settings > Overview).', 2);
  if (token.split('.').length !== 3) die('Need --token-file <file> with the API token (the long token from Settings > Data Export). It did not look like one.', 2);
  saveSecret('clarity', { projectId: project, token, saved: new Date().toISOString() });
  saveConfig({ clarityProjectId: project });
  log('clarity', `saved project ${project} and API token`);
  console.log(`Saved Clarity project ${project} and its API token (kept private, not shown).`);
  console.log('Next: node tools/tracking.mjs container --confirm  (adds the Clarity tag), then node tools/clarity.mjs pull');
}

// ---------- API with a per-day call counter ----------
const counterPath = () => path.join(DIR, `calls-${today()}.json`);
function callsToday() { return readJSON(counterPath(), { calls: 0 }).calls || 0; }
async function clarityCall(token, days, dimension) {
  const used = callsToday();
  if (used >= DAILY_CAP) throw new Error(`daily limit reached (${used} Clarity calls today; Clarity allows 10). Try again tomorrow.`);
  writeJSON(counterPath(), { calls: used + 1, last: new Date().toISOString() });
  const url = `${API}?numOfDays=${days}${dimension ? '&dimension1=' + encodeURIComponent(dimension) : ''}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = null; }
  if (!r.ok) throw new Error(`Clarity API ${r.status}${r.status === 401 ? ' (token is wrong or was deleted; make a new one and run save)' : ''}${r.status === 429 ? ' (too many calls today)' : ''}`);
  if (!Array.isArray(j)) throw new Error('Clarity API returned something unexpected');
  return j;
}

// Flatten Clarity's [{metricName, information:[{...}]}] into rows of numbers.
function flatten(date, dimension, data) {
  const rows = [];
  for (const m of data || []) {
    for (const info of m.information || []) {
      const value = info.Url ?? info.URL ?? info.Device ?? info[dimension] ?? info.name ?? info.url ?? '';
      for (const [k, v] of Object.entries(info)) {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);
        if (n === null) continue;
        rows.push([date, dimension || 'all', String(value), m.metricName, k, n]);
      }
    }
  }
  return rows;
}
const csvCell = (v) => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readFileSync(HISTORY, 'utf8').split('\n').slice(1).filter(Boolean).map(parseCsvLine);
}

// ---------- Google Sheet (drive.file scope: the pack can only see sheets it made) ----------
async function ensureSheet() {
  const c = config();
  if (c.claritySheetId) return c.claritySheetId;
  const { gapi } = await import('../lib/google.mjs');
  const title = `${c.businessName || c.domain || 'Website'} - Clarity daily`;
  const s = await gapi('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', body: { properties: { title }, sheets: [{ properties: { title: 'history' } }] } });
  saveConfig({ claritySheetId: s.spreadsheetId });
  await appendSheet(s.spreadsheetId, [HEADER]);
  console.log(`Created Google Sheet "${title}": https://docs.google.com/spreadsheets/d/${s.spreadsheetId}`);
  return s.spreadsheetId;
}
async function appendSheet(id, rows) {
  const { gapi } = await import('../lib/google.mjs');
  for (let i = 0; i < rows.length; i += 5000) {
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('history!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { values: rows.slice(i, i + 5000) } });
  }
}

async function pull() {
  const s = secret('clarity');
  if (!s?.token) die('Clarity is not set up yet. Run: node tools/clarity.mjs setup', 3);
  const days = Math.min(3, Math.max(1, parseInt(arg('days', '1'), 10) || 1));
  const date = today();
  const rawFile = path.join(DIR, `${date}.json`);
  if (fs.existsSync(rawFile) && !has('force')) { console.log(`Already pulled today (${rawFile}). Add --force to pull again (uses 3 more of today's 10 calls).`); return; }
  if (callsToday() + 3 > DAILY_CAP) die(`Not enough Clarity calls left today (${callsToday()} used, each pull needs 3, cap ${DAILY_CAP}). Try tomorrow.`, 1);

  const snap = { date, projectId: s.projectId, numOfDays: days, pulledAt: new Date().toISOString() };
  snap.all = await clarityCall(s.token, days, null);
  for (const [key, dim] of [['byUrl', 'URL'], ['byDevice', 'Device']]) {
    try { snap[key] = await clarityCall(s.token, days, dim); } catch (e) { snap[key] = { error: e.message }; }
  }
  writeJSON(rawFile, snap);

  const rows = [...flatten(date, null, snap.all), ...(Array.isArray(snap.byUrl) ? flatten(date, 'URL', snap.byUrl) : []), ...(Array.isArray(snap.byDevice) ? flatten(date, 'Device', snap.byDevice) : [])];
  // A forced re-pull replaces that day's rows in the local history (the sheet just gets them again).
  let keep = readHistory();
  if (has('force')) keep = keep.filter((r) => r[0] !== date);
  const all = [...keep, ...rows];
  fs.writeFileSync(HISTORY, [HEADER, ...all].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', { mode: 0o600 });
  log('clarity', `pulled ${date}: ${rows.length} rows`);
  console.log(`Saved ${rawFile} and ${rows.length} rows to ${HISTORY}.`);
  for (const k of ['byUrl', 'byDevice']) if (snap[k]?.error) console.log(`Note: ${k} failed (${snap[k].error}). The totals are saved.`);

  if (has('no-sheet')) return;
  if (!secret('google')?.refresh_token) { console.log('Google is not connected, so no Google Sheet copy this time (node pack.mjs connect). The local files are safe.'); return; }
  try { const id = await ensureSheet(); await appendSheet(id, rows); console.log('Added the rows to the Google Sheet.'); }
  catch (e) { console.log(`Google Sheet not updated (${String(e.message || e).slice(0, 200)}). The local files are safe.`); log('clarity', 'sheet append failed: ' + e.message); }
}

async function sheet() {
  const id = await ensureSheet();
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${id}`);
  const rows = readHistory();
  if (rows.length && has('backfill')) { await appendSheet(id, rows); console.log(`Backfilled ${rows.length} rows.`); }
}

function report() {
  const days = Math.max(1, parseInt(arg('days', '7'), 10) || 7);
  const rows = readHistory();
  if (!rows.length) die('No Clarity history yet. Run: node tools/clarity.mjs pull', 1);
  const dates = [...new Set(rows.map((r) => r[0]))].sort().slice(-days);
  const inRange = rows.filter((r) => dates.includes(r[0]));
  const pick = (dim, metric, field) => inRange.filter((r) => r[1] === dim && r[3] === metric && r[4] === field);
  const sum = (rs) => rs.reduce((a, r) => a + Number(r[5] || 0), 0);
  const sessions = sum(pick('all', 'Traffic', 'totalSessionCount'));
  const users = sum(pick('all', 'Traffic', 'distinctUserCount'));
  const scroll = pick('all', 'ScrollDepth', 'averageScrollDepth');
  const avgScroll = scroll.length ? sum(scroll) / scroll.length : 0;
  const dead = sum(pick('all', 'DeadClickCount', 'subTotal'));
  const rage = sum(pick('all', 'RageClickCount', 'subTotal'));
  const quick = sum(pick('all', 'QuickbackClick', 'subTotal'));
  const pages = {};
  for (const r of pick('all', 'PopularPages', 'visitsCount')) pages[r[2]] = (pages[r[2]] || 0) + Number(r[5] || 0);
  if (!Object.keys(pages).length) for (const r of pick('URL', 'Traffic', 'totalSessionCount')) pages[r[2]] = (pages[r[2]] || 0) + Number(r[5] || 0);
  const devices = {};
  for (const r of pick('Device', 'Traffic', 'totalSessionCount')) devices[r[2]] = (devices[r[2]] || 0) + Number(r[5] || 0);

  console.log(`Clarity summary, ${dates.length} daily pull(s): ${dates[0]} to ${dates[dates.length - 1]}`);
  console.log(`  Sessions: ${sessions}   Visitors: ${users}`);
  console.log(`  Average scroll depth: ${avgScroll.toFixed(1)}%`);
  console.log(`  Dead clicks: ${dead}   Rage clicks: ${rage}   Quick backs: ${quick}`);
  const top = Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) { console.log('  Top pages:'); for (const [u, n] of top) console.log(`    ${n}  ${u}`); }
  const dev = Object.entries(devices).sort((a, b) => b[1] - a[1]);
  if (dev.length) console.log('  Devices: ' + dev.map(([d, n]) => `${d} ${n}`).join(', '));
  if (rage || dead) console.log('  Tip: watch the recordings with rage or dead clicks in Clarity first. They show what is broken or confusing.');
}

const COMMANDS = { setup, save, pull, sheet, report };
if (!COMMANDS[cmd]) {
  console.log('Usage: node tools/clarity.mjs <command>\n  ' + Object.keys(COMMANDS).join('\n  ') + '\nSee the top of this file for flags.');
  process.exit(cmd ? 2 : 0);
}
try { await COMMANDS[cmd](); }
catch (e) { console.error('ERROR ' + (e.message || e)); process.exitCode = 1; }
