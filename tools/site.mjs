#!/usr/bin/env node
// site.mjs: the bot puts the Tag Manager code on the owner's website itself, then checks it is live.
//   node tools/site.mjs snippet --dir <site folder> [--confirm]          static / hand-coded sites: adds the code to every .html page
//   node tools/site.mjs snippet --wordpress [--site https://example.com] [--confirm]
//        WordPress: in the bot's own browser (lib/browser.mjs) it installs the free "Header Footer Code Manager"
//        plugin if needed and adds one site-wide snippet. If the bot browser is not logged in to WordPress it
//        uses the login saved with:  node tools/site.mjs wp-login --user <name> --password-file <file>
//   node tools/site.mjs snippet --print                                    prints the code (any other site builder;
//        the bot then pastes it in that builder's "custom code / header code" box through the bot browser)
//   node tools/site.mjs wp-login --user <name> --password-file <file|->  saves a WordPress admin login privately (0600, plain text,
//        owner-only file). Best: the owner logs in once in the bot browser instead, then no password is stored.
// The GTM id comes from config.json (gtmPublicId, set by tracking container). Never the Facebook Pixel.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { arg, has, die, config, secret, saveSecret, secretArg, log, argv, PACK } from '../lib/core.mjs';

const cmd = argv[0];
const CONFIRM = has('confirm');
const SNIP_NAME = 'Google Tag Manager';

export const headCode = (id) => `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${id}');</script>
<!-- End Google Tag Manager -->`;
export const bodyCode = (id) => `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`;

function gtmId() {
  const id = String(arg('gtm') || config().gtmPublicId || '');
  if (!/^GTM-[A-Z0-9]{4,10}$/.test(id)) die('No Tag Manager container yet. Run: node pack.mjs tracking container --domain <domain> --confirm first.', 2);
  return id;
}
const siteUrl = () => { const s = String(arg('site') || (config().domain ? 'https://' + config().domain : '')).replace(/\/+$/, ''); if (!/^https:\/\/[^/]+$/.test(s)) die('Need --site https://example.com', 2); return s; };
const verifyLive = () => spawnSync(process.execPath, [path.join(PACK, 'tools', 'tracking.mjs'), 'verify'], { stdio: 'inherit' }).status;

// ---------- static sites ----------
function htmlFiles(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = path.join(dir, n), st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) htmlFiles(p, out); else if (/\.html?$/i.test(n)) out.push(p);
  }
  return out;
}
function snippetDir(id) {
  const dir = path.resolve(arg('dir'));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die('--dir must be the website folder.', 2);
  let add = 0, skip = 0, odd = 0;
  for (const f of htmlFiles(dir)) {
    let h = fs.readFileSync(f, 'utf8');
    if (h.includes(id)) { skip++; continue; }
    if (!/<head(\s[^>]*)?>/i.test(h) || !/<body(\s[^>]*)?>/i.test(h)) { odd++; console.log('  no <head> or <body> tag, left alone: ' + path.relative(dir, f)); continue; }
    if (!CONFIRM) { add++; continue; }
    h = h.replace(/<head(\s[^>]*)?>/i, (m) => m + '\n' + headCode(id)).replace(/<body(\s[^>]*)?>/i, (m) => m + '\n' + bodyCode(id));
    fs.writeFileSync(f, h); add++;
  }
  console.log(`${CONFIRM ? 'Added' : 'WOULD add'} ${id} to ${add} page(s). Already had it: ${skip}. Skipped: ${odd}.`);
  if (!CONFIRM) console.log('Dry run. Add --confirm to do it. Then publish the site the way it is normally published, and run: node pack.mjs tracking verify');
  else log('site', `snippet ${id} added to ${add} static pages`);
}

// ---------- WordPress (Header Footer Code Manager) ----------
async function snippetWp(id) {
  const site = siteUrl();
  const b = await import('../lib/browser.mjs');
  if (!CONFIRM) { console.log(`WOULD: in the bot browser, log in to ${site}/wp-admin, make sure "Header Footer Code Manager" is active, and add or update one site-wide snippet "${SNIP_NAME}" with ${id}.`); console.log('Dry run. Add --confirm to do it.'); return; }
  await b.withPage(async (p) => {
    await p.goto(site + '/wp-admin/', { waitUntil: 'domcontentloaded' });
    if (/wp-login\.php/.test(p.url())) {
      if (new URL(p.url()).origin !== new URL(site).origin) throw new Error('WordPress sent the login to a different address (' + new URL(p.url()).origin + '). Not typing the password there. Use the exact site address with --site.');
      const L = secret('wordpress');
      if (!L?.user || !L?.password) throw new Error('the bot browser is not logged in to WordPress. Either the owner logs in once in the bot browser (node pack.mjs browser login), or save a login: node tools/site.mjs wp-login --user <name> --password-file <file>');
      await p.fill('#user_login', L.user); await p.fill('#user_pass', L.password);
      await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.click('#wp-submit')]);
      if (/wp-login\.php/.test(p.url())) throw new Error('WordPress login failed (wrong user or password, or a 2-step code is needed)');
    }
    // Make sure the plugin is installed and active, using WordPress's own REST API with this logged-in session.
    const r = await p.evaluate(async (base) => {
      const nonce = await (await fetch(base + '/wp-admin/admin-ajax.php?action=rest-nonce', { credentials: 'include' })).text();
      const H = { 'X-WP-Nonce': nonce, 'Content-Type': 'application/json' };
      const list = await (await fetch(base + '/wp-json/wp/v2/plugins?search=header-footer-code-manager', { headers: H, credentials: 'include' })).json();
      const hit = Array.isArray(list) ? list.find((x) => /header-footer-code-manager/.test(x.plugin)) : null;
      if (hit && hit.status === 'active') return 'active';
      const res = hit
        ? await fetch(base + '/wp-json/wp/v2/plugins/' + hit.plugin, { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ status: 'active' }) })
        : await fetch(base + '/wp-json/wp/v2/plugins', { method: 'POST', headers: H, credentials: 'include', body: JSON.stringify({ slug: 'header-footer-code-manager', status: 'active' }) });
      return res.ok ? (hit ? 'activated' : 'installed') : 'error ' + res.status + ' ' + (await res.text()).slice(0, 200);
    }, site);
    if (r.startsWith('error')) throw new Error('could not install the Header Footer Code Manager plugin: ' + r + ' (the WordPress user must be an Administrator)');
    console.log('Header Footer Code Manager: ' + r);
    await p.goto(site + '/wp-admin/admin.php?page=hfcm-list', { waitUntil: 'domcontentloaded' });
    const rows = await p.$$eval('#the-list tr', (rs) => rs.map((row) => { const a = row.querySelector('a[href*="hfcm-update"]'); return [row.textContent.replace(/\s+/g, ' '), a ? new URL(a.href).searchParams.get('id') : '']; }));
    const hit = rows.find(([txt, sid]) => sid && new RegExp('(^|\\s)' + SNIP_NAME + '(?! ?\\d)(\\s|$)').test(txt));
    await p.goto(site + '/wp-admin/admin.php?page=' + (hit ? 'hfcm-update&id=' + hit[1] : 'hfcm-create'), { waitUntil: 'domcontentloaded' });
    await p.fill('input[name="data[name]"]', SNIP_NAME);
    await p.selectOption('select[name="data[snippet_type]"]', 'html');
    await p.selectOption('select[name="data[display_on]"]', 'All');
    await p.selectOption('select[name="data[location]"]', 'header');
    await p.selectOption('select[name="data[device_type]"]', 'both');
    await p.selectOption('select[name="data[status]"]', 'active');
    await p.evaluate((code) => { const ta = document.querySelector('textarea[name="data[snippet]"]'); ta.value = code; const cm = document.querySelector('.CodeMirror'); if (cm && cm.CodeMirror) cm.CodeMirror.setValue(code); }, headCode(id));
    await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.evaluate(() => document.querySelector('input[name="insert"], input[name="update"], button[name="update"], #publish, form input[type=submit]').click())]);
    console.log(`${hit ? 'Updated' : 'Added'} the site-wide "${SNIP_NAME}" snippet (${id}).`);
  });
  log('site', `wordpress snippet ${id} on ${site}`);
  // Caches can hold the old page for a bit; check a few times.
  for (let i = 0; i < 4; i++) { if (verifyLive() === 0) return; await new Promise((r) => setTimeout(r, 15000)); }
  console.log('Saved in WordPress, but the live page does not show it yet. If the site has a cache plugin, clear its cache, then run: node pack.mjs tracking verify');
  process.exitCode = 2;
}

async function main() {
  if (cmd === 'wp-login') {
    const user = arg('user'), pw = secretArg('password');
    if (!user || !pw) die('Need --user <name> --password-file <file> (or --password-file - to read it from stdin).', 2);
    saveSecret('wordpress', { user, password: pw, saved: new Date().toISOString() });
    console.log('WordPress login saved privately (not shown).'); return;
  }
  if (cmd !== 'snippet') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(cmd ? 2 : 0); }
  const id = gtmId();
  if (has('print')) { console.log('HEAD (as high as possible in <head> on every page):\n' + headCode(id) + '\n\nBODY (right after the opening <body> tag):\n' + bodyCode(id)); return; }
  if (arg('dir')) return snippetDir(id);
  if (has('wordpress')) return snippetWp(id);
  die('Pick one: --dir <site folder>, --wordpress, or --print', 2);
}
try { await main(); } catch (e) { console.error('ERROR ' + (e.message || e)); process.exitCode = 1; }
