#!/usr/bin/env node
// pack.mjs: the ONE entry point of the Google Ads Pack. Your bot runs everything through here.
//   node pack.mjs doctor                         what is set up, what is missing, the next step
//   node pack.mjs set --name "<Business>" --domain example.com [--ads 123-456-7890] [--business "what you sell"] [--services "a,b"] [--targets "a,b"] [--protect "brand"] [--competitors "x,y"] [--timezone America/New_York] [--negatives auto|propose]
//   node pack.mjs connect --client <client_secret.json> [--listen]   one-time Google login (prints the Allow link)
//   node pack.mjs connect --code "<the localhost address Google sent you to>"
//   node pack.mjs tracking ...   GA4 account/property, GTM account/container, conversions   (tools/tracking.mjs)
//   node pack.mjs site     ...   put the Tag Manager code on the website itself (WordPress / folder / print)  (tools/site.mjs)
//   node pack.mjs browser setup|login|status|start|stop   the bot's own hidden Chrome for steps with no API (lib/browser.mjs)
//   node pack.mjs clarity  ...   Microsoft Clarity setup + daily data                        (tools/clarity.mjs)
//   node pack.mjs ads      ...   read + change Google Ads                                   (tools/ads.mjs)
//   node pack.mjs negatives ...  standard list, daily sweep, conflicts                      (tools/negatives.mjs)
//   node pack.mjs campaign ...   plan + create campaigns (always PAUSED until the owner says yes)
//   node pack.mjs report  weekly Keep / Fix / Stop report
//   node pack.mjs daily          the daily job: Clarity pull + negatives sweep (+ weekly report on Mondays)
//   node pack.mjs schedule [--remove]   installs the daily + update jobs (cron on Linux/Mac, Task Scheduler on Windows)
//   node pack.mjs update         pulls the newest pack (your settings and data are never touched)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { PACK, HOME, DATA, argv, arg, has, die, config, saveConfig, secret, saveSecret, secretArg, readJSON, log, scrub } from './lib/core.mjs';
import { authUrl, exchange, checkState, REDIRECT } from './lib/google.mjs';

const cmd = argv[0];
const TOOLS = { site: 'site.mjs', tracking: 'tracking.mjs', clarity: 'clarity.mjs', ads: 'ads.mjs', negatives: 'negatives.mjs', campaign: 'campaign.mjs', report: 'report.mjs' };
const runTool = (t, args, opts = {}) => spawnSync(process.execPath, [path.join(PACK, 'tools', TOOLS[t]), ...args], { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', env: process.env, timeout: 30 * 60e3 });
const version = () => (readJSON(path.join(PACK, 'manifest.json'), {}).version || 'dev');

// Send a short message to the owner if their bot set a notify command (it gets the text on stdin), else just log it.
function notify(text) {
  log('notify', text.replace(/\n/g, ' | '));
  const c = process.env.GADS_NOTIFY_CMD || config().notifyCmd;
  if (c) spawnSync(c, { shell: true, input: text, encoding: 'utf8', timeout: 120e3 });
  else console.log(text);
}

if (cmd === 'browser') {
  const b = await import('./lib/browser.mjs');
  const sub = argv[1] || 'status';
  try {
    if (sub === 'setup') { b.setup(); console.log('Browser helper installed. Chrome found: ' + (b.chromePath() || 'NO, install Google Chrome')); }
    else if (sub === 'login') {
      await b.stop(); await b.start({ visible: true, url: 'https://accounts.google.com/' });
      console.log('A Chrome window opened (the bot\'s own browser, separate from yours). Sign in to the Google account that owns the ads,');
      console.log('and in another tab log in to your website admin (WordPress etc.) and tick "remember me". Then close that window.');
      console.log('The bot reuses these logins from now on, hidden, and never touches your normal Chrome.');
    } else if (sub === 'start') { await b.start(); console.log('Bot browser running (hidden) on 127.0.0.1:' + b.PORT); }
    else if (sub === 'stop') { console.log(await b.stop() ? 'Stopped.' : 'Was not running.'); }
    else if (sub === 'status') {
      const pw = await b.playwright().then(() => true, () => false);
      console.log(`Chrome: ${b.chromePath() || 'NOT FOUND'}\nHelper installed: ${pw ? 'yes' : 'no (node pack.mjs browser setup)'}`);
      if (pw && b.chromePath()) console.log('Google in the bot browser: ' + (await b.googleSignedIn() ? 'SIGNED IN' : 'SIGNED OUT (node pack.mjs browser login)'));
    } else die('browser setup | login | status | start | stop');
  } catch (e) { die('Browser: ' + scrub(e.message), 1); }
  process.exit(0);
}

if (TOOLS[cmd]) { const r = runTool(cmd, argv.slice(1)); process.exit(r.status ?? 1); }

if (cmd === 'set') {
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const p = {};
  if (arg('name')) p.businessName = arg('name');
  if (arg('domain')) p.domain = arg('domain').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const adsId = (v, what) => { const d = String(v).replace(/-/g, ''); if (!/^\d{10}$/.test(d)) die(`${what} must be a 10 digit Google Ads id like 123-456-7890.`); return d; };
  if (arg('ads')) p.adsCustomerId = adsId(arg('ads'), '--ads');
  if (arg('manager')) p.adsLoginCustomerId = adsId(arg('manager'), '--manager');
  if (arg('business')) p.business = arg('business');
  for (const k of ['services', 'targets', 'protect', 'competitors', 'offNiche']) if (arg(k)) p[k] = list(arg(k));
  if (arg('timezone')) p.timezone = arg('timezone');
  if (arg('negatives')) { if (!['auto', 'propose'].includes(arg('negatives'))) die('--negatives must be auto or propose'); p.negativesMode = arg('negatives'); }
  if (arg('notify')) p.notifyCmd = arg('notify');
  if (arg('developer-token') || arg('client-secret')) die('For safety, secrets are never taken on the command line. Use --developer-token-file <file> or --client-secret-file <file> (or - for stdin).');
  if (secretArg('developer-token')) { const g = secret('google') || {}; saveSecret('google', { ...g, developer_token: secretArg('developer-token') }); console.log('Developer token saved privately.'); }
  const c = saveConfig(p);
  const shown = { ...c }; for (const k of ['notifyCmd', 'aiCmd']) if (shown[k]) shown[k] = '<set, hidden>';
  console.log('Saved. Settings now:\n' + JSON.stringify(shown, null, 1));
  process.exit(0);
}

if (cmd === 'connect') {
  if (arg('client')) {
    const raw = readJSON(arg('client')); const cl = raw?.installed || raw?.web || raw;
    if (!cl?.client_id || !cl?.client_secret) die('That file is not a Google OAuth client file (needs client_id + client_secret).');
    saveSecret('google-client', { client_id: cl.client_id, client_secret: cl.client_secret });
    try { fs.unlinkSync(arg('client')); console.log('(Deleted the downloaded client file; a private copy is saved.)'); } catch {}
  } else if (arg('client-id') && secretArg('client-secret')) saveSecret('google-client', { client_id: arg('client-id'), client_secret: secretArg('client-secret') });
  const client = secret('google-client');
  if (!client) die('First give me the Google login key: node pack.mjs connect --client <downloaded client_secret file>. See OWNER-GUIDE.md step 2.');
  const code = arg('code');
  if (code) {
    // Only the FULL address Google sent the browser to is accepted (it carries the state this computer made). Never a bare code.
    const m = /[?&]code=([^&\s]+)/.exec(code), st = /[?&]state=([^&\s]+)/.exec(code);
    if (!m || !st) die('Paste the WHOLE address the browser went to after Allow (it starts with ' + REDIRECT + '?state=...), not just the code.');
    try { const verifier = checkState(decodeURIComponent(st[1])); const who = await exchange(client, decodeURIComponent(m[1]), verifier); console.log(`CONNECTED as ${who || 'unknown account'}. Google is linked for good (Ads, Analytics, Tag Manager, Drive files). If that is not the owner's Google login, run connect again. Next: node pack.mjs doctor`); process.exit(0); }
    catch (e) { die(scrub(e.message), 1); }
  }
  const url = authUrl(client.client_id);
  console.log('OPEN THIS LINK, pick the Google login that owns the ad account, and click Allow (if Google says the app is unverified, click Advanced, then Go to the app; it is your own app):\n\n' + url + '\n');
  if (!has('listen')) { console.log(`After Allow, your browser goes to ${REDIRECT}... and may show "can't connect". That is normal. Copy that whole address and run:\n  node pack.mjs connect --code "<paste it here>"`); process.exit(0); }
  // Same computer as the browser (Claude Code on the owner's machine): catch the answer by itself for 10 minutes.
  const srv = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url, REDIRECT); } catch { res.writeHead(400); res.end(); return; }
    const c = u.searchParams.get('code');
    if (!c) { res.end('Waiting for Google...'); return; }
    let verifier; try { verifier = checkState(u.searchParams.get('state') || ''); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Ignored: this answer was not for this computer.'); return; }
    try { const who = await exchange(client, c, verifier); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Connected. You can close this tab.'); console.log(`CONNECTED as ${who || 'unknown account'}. Next: node pack.mjs doctor`); srv.close(); process.exit(0); }
    catch (e) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('That did not work: ' + scrub(e.message)); console.error(scrub(e.message)); srv.close(); process.exit(1); }
  });
  srv.listen(8765, '127.0.0.1', () => console.log('Waiting up to 10 minutes for the Allow click...'));
  setTimeout(() => { console.error('No Allow click in 10 minutes. Run connect again.'); process.exit(1); }, 600e3);
} else if (cmd === 'doctor') {
  const c = config(), g = secret('google'), cl = secret('clarity');
  const lines = [], next = [];
  const ok = (good, label, fix) => { lines.push(`${good ? 'OK  ' : 'TODO'} ${label}`); if (!good && fix) next.push(fix); };
  ok(Number(process.versions.node.split('.')[0]) >= 18, `Node ${process.versions.node} (18+ needed)`, 'Install Node 18 or newer.');
  ok(c.businessName && c.domain, `Business: ${c.businessName || '?'} / ${c.domain || '?'}`, 'Ask the owner for the business name, website, and one line on what they sell, then: node pack.mjs set --name "..." --domain ... --business "..."');
  ok(!!secret('google-client') || !!secret('google')?.client_id, 'Google login key (OAuth client)', 'Owner step 2 in OWNER-GUIDE.md (make the Google login key), then: node pack.mjs connect --client <file>');
  ok(!!g?.refresh_token, 'Google connected (one Allow click)', 'node pack.mjs connect (send the owner the Allow link)');
  let adsOk = false;
  if (g?.refresh_token) {
    try { const { adsApi } = await import('./lib/ads.mjs'); const j = await adsApi('customers:listAccessibleCustomers'); adsOk = (j.resourceNames || []).length > 0; lines.push(`     Ads accounts this login reaches: ${(j.resourceNames || []).map((r) => r.split('/')[1]).join(', ') || 'none'}`); }
    catch (e) { lines.push('     Ads API: ' + scrub(e.message).slice(0, 200)); }
  }
  ok(adsOk, 'Google Ads API works', 'Owner step 3: turn on the Google Ads API for their Cloud project (OWNER-GUIDE.md). If the error says developer token, see OWNER-GUIDE.md "If Google asks for a developer token".');
  ok(!!c.adsCustomerId, `Ad account picked: ${c.adsCustomerId || '-'}`, 'node pack.mjs ads accounts, then node pack.mjs set --ads <id>');
  ok(!!c.ga4AccountId && !!c.ga4MeasurementId, `GA4: account ${c.ga4AccountId || '-'}, ${c.ga4MeasurementId || '-'}`, 'node pack.mjs tracking ga4-account --name "<Business>" then ga4-property (skills/google-setup/SKILL.md)');
  ok(!!c.gtmAccountId, `GTM account: ${c.gtmAccountId || '-'}`, 'node pack.mjs tracking gtm-account --name "<Business>" --domain <domain>');
  ok(!!cl?.token && !!c.clarityProjectId, `Clarity: ${c.clarityProjectId || '-'}`, 'node pack.mjs clarity setup (owner signs in to Clarity once and copies 2 things)');
  ok(!!c.gtmPublicId, `GTM container live: ${c.gtmPublicId || '-'}`, 'node pack.mjs tracking container --domain <domain> --confirm');
  if (c.gtmPublicId && c.domain) {
    let live = false; try { live = (await (await fetch(`https://${c.domain}/`, { signal: AbortSignal.timeout(15000) })).text()).includes(c.gtmPublicId); } catch {}
    ok(live, `Tag Manager code on ${c.domain}: ${live ? 'yes' : 'not found'}`, 'node pack.mjs site snippet --wordpress --confirm  (or --dir <site folder>, or --print for other builders), then node pack.mjs tracking verify');
  }
  ok(!c.adsCustomerId || c.ga4AdsLinkCustomer === c.adsCustomerId, `GA4 linked to Google Ads: ${c.ga4AdsLinkCustomer || '-'}`, 'node pack.mjs tracking ads-link --confirm');
  ok(!!c.conversionsDone, 'Conversions (Opt In / Booked Call)', 'node pack.mjs tracking conversions ... (needs the thank-you page paths)');
  const sched = readJSON(path.join(HOME, 'schedule.json'));
  ok(!!sched, `Daily jobs scheduled: ${sched ? sched.how : '-'}`, 'node pack.mjs schedule');
  console.log(`Google Ads Pack ${version()}  (settings: ${HOME})\n` + lines.join('\n'));
  console.log(next.length ? `\nNEXT: ${next[0]}` : '\nALL SET. The bot runs the daily jobs and brings the owner decisions only.');
  process.exit(0);
} else if (cmd === 'daily') {
  const c = config(), out = [];
  if (secret('clarity')) { const r = runTool('clarity', ['pull', '--days', '1'], { capture: true }); out.push('Clarity: ' + (r.status === 0 ? 'saved today\'s data' : 'pull failed: ' + scrub(r.stderr || r.stdout).slice(-200))); }
  if (c.adsCustomerId && secret('google')) {
    const auto = (c.negativesMode || 'auto') === 'auto';
    const r = runTool('negatives', ['sweep', '--days', '3', ...(auto ? ['--confirm'] : [])], { capture: true });
    out.push((r.stdout || '').trim().split('\n').slice(-6).join('\n') || ('Negatives sweep failed: ' + scrub(r.stderr).slice(-200)));
    if (new Date().getDay() === 1) { const w = runTool('report', ['weekly'], { capture: true }); out.push((w.stdout || '').trim().split('\n').slice(-8).join('\n')); }
  }
  notify(`Google Ads Pack daily (${new Date().toISOString().slice(0, 10)}):\n` + out.filter(Boolean).join('\n'));
  process.exit(0);
} else if (cmd === 'schedule') {
  const node = process.execPath, me = path.join(PACK, 'pack.mjs'), logf = path.join(DATA, 'logs', 'cron.log');
  fs.mkdirSync(path.dirname(logf), { recursive: true });
  const tag = '# google-ads-pack';
  if (process.platform === 'win32') {
    if (/["%&|<>^]/.test(node + me)) die('The pack folder or Node path contains one of " % & | < > ^. Move the pack to a plain folder (for example C:\\google-ads-pack) and run schedule again.');
    const jobs = [['GoogleAdsPack-daily', '06:30', 'daily'], ['GoogleAdsPack-update', '05:30', 'update']];
    for (const [n, t, a] of jobs) {
      const q = has('remove') ? ['/Delete', '/F', '/TN', n] : ['/Create', '/F', '/SC', 'DAILY', '/ST', t, '/TN', n, '/TR', `"${node}" "${me}" ${a}`];
      const r = spawnSync('schtasks', q, { encoding: 'utf8' }); console.log(n, r.status === 0 ? 'ok' : r.stderr);
    }
  } else {
    if (/["%$`\\\n]/.test(node + me + logf + HOME)) die('The pack folder or Node path contains one of " % $ ` \\. Move the pack to a plain folder (for example ~/google-ads-pack) and run schedule again.');
    let cur = ''; try { cur = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
    const keep = cur.split('\n').filter((l) => l && !l.includes(tag));
    const add = has('remove') ? [] : [
      `30 6 * * * GADS_HOME="${HOME}" "${node}" "${me}" daily >> "${logf}" 2>&1 ${tag} daily`,
      `30 5 * * * GADS_HOME="${HOME}" "${node}" "${me}" update >> "${logf}" 2>&1 ${tag} update`,
    ];
    const r = spawnSync('crontab', ['-'], { input: [...keep, ...add].join('\n') + '\n', encoding: 'utf8' });
    if (r.status !== 0) die('Could not write the crontab: ' + r.stderr + '\nIf this is Claude Code without cron, ask Claude Code to create two scheduled tasks that run: node ' + me + ' daily (6:30 AM) and node ' + me + ' update (5:30 AM).', 1);
  }
  if (has('remove')) { try { fs.unlinkSync(path.join(HOME, 'schedule.json')); } catch {} console.log('Schedule removed.'); }
  else { fs.writeFileSync(path.join(HOME, 'schedule.json'), JSON.stringify({ how: process.platform === 'win32' ? 'Task Scheduler' : 'cron', at: new Date().toISOString(), daily: '06:30 local', update: '05:30 local' })); console.log('Scheduled: daily job 6:30 AM, update check 5:30 AM (this computer\'s time). The computer must be on at those times.'); }
  process.exit(0);
} else if (cmd === 'update') {
  // The pack folder is a git clone of the public pack. Settings + data live in ~/.google-ads-pack, so a pull never touches them.
  if (!fs.existsSync(path.join(PACK, '.git'))) die('This copy was not installed with git, so it cannot update itself. Reinstall with the git command in INSTALL.md.', 1);
  // Download first, check the new version with the CURRENTLY installed release key and checker, and only then switch.
  // A version that is not signed by that key, or has a changed/extra file, is never used.
  const before = version();
  // Hardened git: no hooks, no fsmonitor, no submodules, so nothing in the download can run code.
  const git = (...a) => spawnSync('git', ['-C', PACK, '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...a], { encoding: 'buffer', maxBuffer: 50e6 });
  const f = git('fetch', '-q', 'origin', 'main');
  if (f.status !== 0) die('Update failed (download): ' + String(f.stderr).slice(-300), 1);
  const head = String(git('rev-parse', 'FETCH_HEAD').stdout).trim();
  if (head === String(git('rev-parse', 'HEAD').stdout).trim()) { console.log(`Up to date (${before}).`); process.exit(0); }
  const { checkRelease } = await import('./tools/verify-pack.mjs');
  const pubPath = path.join(PACK, 'release-key.pub');
  if (!fs.existsSync(pubPath)) die('This copy has no release key, so it cannot check updates safely. Reinstall with the git command in INSTALL.md.', 1);
  const read = (rel) => { const r = git('show', `${head}:${rel}`); return r.status === 0 ? r.stdout : null; };
  const list = () => String(git('ls-tree', '-r', head).stdout).split('\n').filter(Boolean).map((l) => { const [meta, rel] = l.split('\t'); return { rel, mode: meta.split(' ')[0] }; });
  const chk = checkRelease({ read, list, pubPem: fs.readFileSync(pubPath, 'utf8') });
  if (!chk.ok) { log('update', 'REFUSED ' + chk.problems.slice(0, 5).join('; ')); die('Update REFUSED, the new version is not genuine: ' + chk.problems.slice(0, 5).join('; ') + '. Kept the current version.', 1); }
  const cur = readJSON(path.join(PACK, 'manifest.json'), {});
  // Anti-rollback: a genuine but OLDER signed version is refused too. Same build = nothing new.
  // Both build times must be readable, and the new one must be strictly newer. Anything else fails CLOSED.
  const tNew = Date.parse(chk.manifest.built), tCur = Date.parse(cur.built);
  if (Number.isNaN(tNew) || Number.isNaN(tCur)) die('Update REFUSED: a build time is missing or unreadable. Kept the current version. If this keeps happening, reinstall with the git command in INSTALL.md.', 1);
  if (tNew === tCur) { console.log(`Up to date (${before}).`); process.exit(0); }
  if (tNew < tCur) die('Update REFUSED: the download is OLDER than this copy. Kept the current version.', 1);
  if (String(git('status', '--porcelain', '--untracked-files=no').stdout).trim()) die('Update skipped: files in the pack folder were changed by hand. Settings belong in ' + HOME + ', not in the pack. Reinstall or undo the edits, then update.', 1);
  const old = String(git('rev-parse', 'HEAD').stdout).trim();
  const mg = git('reset', '-q', '--hard', head);
  if (mg.status !== 0) die('Update failed (switch): ' + String(mg.stderr).slice(-300) + ' Kept the current version.', 1);
  // Check again what is now really on disk (catches case-insensitive disks and line-ending changes). Roll back if it does not match.
  const disk = spawnSync(process.execPath, [path.join(PACK, 'tools', 'verify-pack.mjs')], { encoding: 'utf8' });
  if (disk.status !== 0 || !/^PASS /m.test(disk.stdout || '')) { git('reset', '-q', '--hard', old); log('update', 'ROLLED BACK after disk check: ' + disk.stdout.slice(-200)); die('Update ROLLED BACK: the files on disk did not match the signed list after switching. ' + disk.stdout.slice(-200), 1); }
  const after = version(); log('update', `${before} -> ${after}`);
  console.log(before === after ? `Up to date (${after}).` : `Updated ${before} -> ${after}. Read CHANGELOG.md for what changed.`);
  process.exit(0);
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 2 : 0);
}
