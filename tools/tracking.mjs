#!/usr/bin/env node
// tracking.mjs: the standard Google tracking setup for one business website.
// GA4 account + property, GTM account + container (locked template), Microsoft Clarity tag,
// and Google Ads funnel conversions (Opt In + Booked Call). No Hotjar. Never the Facebook Pixel.
//
// Order (each step saves its ids in $GADS_HOME/config.json, so later steps need fewer flags):
//   node tools/tracking.mjs ga4-account  --name "<Business>" [--confirm] | --check
//   node tools/tracking.mjs ga4-property --name "<Business>" --domain example.com [--timezone America/Chicago] [--currency USD] [--confirm]
//   node tools/tracking.mjs gtm-account  --name "<Business>" --domain example.com [--browser --confirm]
//   node tools/tracking.mjs ads-link     [--ads 123-456-7890] [--property <ga4 id>] [--confirm]   link GA4 to the Google Ads account
//   node tools/tracking.mjs container    --domain example.com [--confirm]
//   node tools/tracking.mjs verify       --url https://example.com/
//   node tools/tracking.mjs conversions  --goal optin|booked|both --optin-path /thank-you-optin --booked-path /thank-you-booked [--confirm]
//   node tools/tracking.mjs conversions-verify --site https://example.com --optin-path ... --booked-path ...
//
// Every command that changes a live account is a DRY RUN until you add --confirm.
import { arg, has, die, config, saveConfig, log, argv } from '../lib/core.mjs';
import { gapi, REDIRECT } from '../lib/google.mjs';

const cmd = argv[0];
const CONFIRM = has('confirm');
const ALL_PAGES = '2147479553';
const ADM = 'https://analyticsadmin.googleapis.com/v1beta';
const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';

// The 33 built-in GTM variables of the locked template (0 user-defined variables).
const BUILTINS = ['clickElement', 'clickClasses', 'clickId', 'clickTarget', 'clickUrl', 'clickText',
  'formElement', 'formClasses', 'formId', 'formTarget', 'formUrl', 'formText',
  'containerVersion', 'randomNumber', 'containerId', 'htmlId', 'environmentName',
  'videoProvider', 'videoUrl', 'videoTitle', 'videoDuration', 'videoPercent', 'videoVisible', 'videoStatus', 'videoCurrentTime',
  'scrollDepthThreshold', 'scrollDepthUnits', 'scrollDepthDirection',
  'pageUrl', 'pageHostname', 'pagePath', 'referrer', 'event'];

const TAG_LINKER = 'Conversion Linker';
const TAG_GA4 = 'Google Tag - GA4';
const TAG_CLARITY = 'Microsoft Clarity';
const claritySnippet = (id) =>
  `<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${id}");</script>`;

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const sameHost = (u, host) => { try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; } };
const bizName = () => String(arg('name') || config().businessName || '').trim();
const bizDomain = () => cleanDomain(arg('domain') || config().domain);
const need = (v, msg) => { if (!v) die(msg, 2); return v; };
const dry = (msg) => console.log((CONFIRM ? 'DO: ' : 'WOULD: ') + msg);

// GTM allows about 30 calls a minute per user. Pace calls and retry a 429 once after a minute.
let lastGtm = 0;
async function gtm(path, opts = {}) {
  const wait = lastGtm + 2100 - Date.now(); if (wait > 0) await sleep(wait);
  lastGtm = Date.now();
  const url = path.startsWith('http') ? path : `${GTM}/${path.replace(/^\//, '')}`;
  try { return await gapi(url, opts); }
  catch (e) {
    if (e.status !== 429) throw e;
    console.log('Tag Manager says slow down. Waiting 60 seconds, then one retry.');
    await sleep(60000); lastGtm = Date.now();
    return gapi(url, opts);
  }
}

async function listAll(url, key) {
  const out = []; let pt = '';
  do {
    const j = await gapi(url + (url.includes('?') ? '&' : '?') + 'pageSize=200' + (pt ? '&pageToken=' + encodeURIComponent(pt) : ''));
    out.push(...(j[key] || [])); pt = j.nextPageToken || '';
  } while (pt);
  return out;
}

// ---------- GA4 ----------
async function findGa4Account(name) {
  const accts = await listAll(`${ADM}/accounts`, 'accounts');
  return accts.find((a) => String(a.displayName).trim().toLowerCase() === name.toLowerCase());
}

async function ga4Account() {
  const name = need(bizName(), 'Need --name "<Business>" (the exact name for the Google Analytics account).');
  const found = await findGa4Account(name);
  if (found) {
    const id = found.name.split('/')[1];
    saveConfig({ businessName: name, ga4AccountId: id });
    console.log(`GA4 account "${name}" found: ${id}. Saved as ga4AccountId.`);
    return;
  }
  if (has('check')) {
    console.log(`No GA4 account named "${name}" yet. If you just clicked Accept on the Terms page, wait a minute and run --check again.`);
    process.exitCode = 1; return;
  }
  if (!CONFIRM) {
    dry(`create a Google Analytics account "${name}" (region US). You will then click Accept on Google's Terms page once.`);
    console.log('Dry run. Add --confirm to create it.'); return;
  }
  const j = await gapi(`${ADM}/accounts:provisionAccountTicket`, { method: 'POST', body: { account: { displayName: name, regionCode: 'US' }, redirectUri: REDIRECT } });
  const ticket = j.accountTicketId;
  if (!ticket) die('Google did not return an account ticket. Nothing was created.', 1);
  saveConfig({ businessName: name });
  log('tracking', `ga4-account ticket created for "${name}"`);
  const tos = `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${ticket}`;
  const b = await botBrowser();
  if (b) {
    try {
      await b.withPage(async (p) => {
        await p.goto(tos, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(8000);
        if (/accounts\.google\.com/.test(p.url())) throw new Error('bot browser not signed in to Google');
        // Only the required terms box (Data Processing Terms), never optional data-sharing boxes.
        const req = p.getByRole('checkbox', { name: /Data Processing Terms|I also accept/i });
        for (const cb of await req.all()) if (!(await cb.isChecked().catch(() => true))) await cb.check().catch(() => {});
        await p.getByRole('button', { name: /I Accept/i }).first().click();
        await p.waitForTimeout(8000);
      });
      for (let i = 0; i < 6; i++) { const f = await findGa4Account(name); if (f) { const id = f.name.split('/')[1]; saveConfig({ ga4AccountId: id }); console.log(`Terms accepted by the bot. GA4 account ${id} created and saved.`); return; } await sleep(5000); }
    } catch (e) { console.log('The bot could not click the Terms page (' + e.message + '). Falling back to the owner link below.'); }
  }
  console.log('Almost done. Open this link while signed in to the same Google account, tick the boxes and click "I Accept":');
  console.log('  ' + tos);
  console.log('After that page says it is done (it may show a localhost page that does not load; that is fine), run:');
  console.log(`  node tools/tracking.mjs ga4-account --name "${name}" --check`);
}

async function ga4Property() {
  const name = need(bizName(), 'Need --name "<Business>".');
  const domain = need(bizDomain(), 'Need --domain example.com.');
  const acct = need(config().ga4AccountId, 'No GA4 account saved yet. Run: node tools/tracking.mjs ga4-account --name "<Business>" first.');
  const tz = arg('timezone') || config().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const currency = arg('currency', 'USD');
  const site = `https://${domain}/`;

  // Reuse: any property in the account whose web stream points at this domain.
  const props = await listAll(`${ADM}/properties?filter=${encodeURIComponent('parent:accounts/' + acct)}`, 'properties');
  for (const p of props) {
    const streams = await listAll(`${ADM}/${p.name}/dataStreams`, 'dataStreams');
    const hit = streams.find((s) => s.webStreamData && sameHost(s.webStreamData.defaultUri, domain));
    if (hit) {
      const pid = p.name.split('/')[1], mid = hit.webStreamData.measurementId;
      saveConfig({ businessName: name, domain, ga4PropertyId: pid, ga4MeasurementId: mid });
      console.log(`Reusing GA4 property ${pid} "${p.displayName}" with web stream ${mid}. Saved.`);
      return;
    }
  }
  // A property with the same name but no stream for this site: add the stream to it.
  const sameName = props.find((p) => String(p.displayName).trim().toLowerCase() === name.toLowerCase());
  if (!CONFIRM) {
    if (sameName) dry(`add a web data stream for ${site} to the existing property "${sameName.displayName}".`);
    else dry(`create GA4 property "${name}" (time zone ${tz}, currency ${currency}) with a web data stream for ${site}.`);
    console.log('Dry run. Add --confirm to do it.'); return;
  }
  let propName = sameName?.name;
  if (!propName) {
    const prop = await gapi(`${ADM}/properties`, { method: 'POST', body: { parent: `accounts/${acct}`, displayName: name, timeZone: tz, currencyCode: currency } });
    propName = prop.name;
    console.log(`Created GA4 property ${propName.split('/')[1]}.`);
  }
  const stream = await gapi(`${ADM}/${propName}/dataStreams`, { method: 'POST', body: { type: 'WEB_DATA_STREAM', displayName: 'Website', webStreamData: { defaultUri: site } } });
  const pid = propName.split('/')[1], mid = stream.webStreamData?.measurementId;
  if (!mid) die('The web stream was made but Google did not return a Measurement ID. Run ga4-property again to pick it up.', 1);
  saveConfig({ businessName: name, domain, ga4PropertyId: pid, ga4MeasurementId: mid });
  log('tracking', `ga4-property ${pid} stream ${mid} for ${domain}`);
  console.log(`GA4 ready. Property ${pid}, Measurement ID ${mid}. Saved.`);
}

// ---------- GA4 <-> Google Ads link (GA4 Admin > Product links > Google Ads links) ----------
// Same result as the manual steps: link the property to the ad account, Personalized Advertising ON,
// Auto-Tagging ON (auto-tagging is a Google Ads account setting, so it is turned on through the Ads API).
// Needs: edit on the GA4 property and admin on the Google Ads account (the owner's own login has both).
async function adsLink() {
  const c = config();
  const pid = need(String(arg('property') || c.ga4PropertyId || ''), 'No GA4 property saved yet. Run: node tools/tracking.mjs ga4-property first (or add --property <id>).');
  const cid = need(String(arg('ads') || c.adsCustomerId || '').replace(/-/g, ''), 'No Google Ads account set. Run: node pack.mjs ads accounts, then node pack.mjs set --ads <id> (or add --ads <id>).');
  const nice = cid.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  const links = await listAll(`${ADM}/properties/${pid}/googleAdsLinks`, 'googleAdsLinks');
  let link = links.find((l) => String(l.customerId) === cid);
  const { search, adsApi } = await adsLib();
  let autoTag = null;
  try { autoTag = (await search('SELECT customer.auto_tagging_enabled FROM customer', cid))[0]?.customer?.autoTaggingEnabled === true; }
  catch (e) { console.log('Could not read auto-tagging from Google Ads: ' + String(e.message).slice(0, 200)); }
  const persOff = link && link.adsPersonalizationEnabled === false;
  if (link && !persOff && autoTag === true) {
    saveConfig({ ga4AdsLink: link.name, ga4AdsLinkCustomer: cid });
    console.log(`PASS GA4 property ${pid} is linked to Google Ads ${nice}. Personalized Advertising ON, Auto-Tagging ON.`);
    return;
  }
  if (!CONFIRM) {
    if (!link) dry(`link GA4 property ${pid} to Google Ads ${nice} with Personalized Advertising ON.`);
    if (persOff) dry('turn Personalized Advertising ON for the existing link.');
    if (autoTag === false) dry(`turn Auto-Tagging ON in Google Ads ${nice}.`);
    if (autoTag === null) dry('check Auto-Tagging once the Google Ads API works (could not read it now).');
    console.log('Dry run. Add --confirm to do it.'); return;
  }
  if (!link) {
    try { link = await gapi(`${ADM}/properties/${pid}/googleAdsLinks`, { method: 'POST', body: { customerId: cid, adsPersonalizationEnabled: true } }); }
    catch (e) {
      if (e.status === 403) die(`Google refused the link (${String(e.message).slice(0, 160)}). The Google login must be an ADMIN on Google Ads ${nice} and an Editor on the GA4 property. Add it in Google Ads (Admin > Access and security), then run this again.`, 1);
      throw e;
    }
    console.log(`Linked GA4 property ${pid} to Google Ads ${nice}.`);
  } else if (persOff) {
    link = await gapi(`${ADM}/${link.name}?updateMask=adsPersonalizationEnabled`, { method: 'PATCH', body: { adsPersonalizationEnabled: true } });
    console.log('Personalized Advertising turned ON.');
  }
  if (autoTag === null) console.log('Could not check Auto-Tagging (no Google Ads API access yet). The link is made; run ads-link again once doctor shows "Google Ads API works".');
  else if (autoTag !== true) {
    await adsApi(`customers/${cid}:mutate`, { operation: { update: { resourceName: `customers/${cid}`, autoTaggingEnabled: true }, updateMask: 'autoTaggingEnabled' } });
    console.log('Auto-Tagging turned ON in Google Ads.');
  }
  saveConfig({ ga4AdsLink: link.name, ga4AdsLinkCustomer: cid });
  log('tracking', `ads-link ${pid} -> ${cid}`);
  console.log('Done. Check it any time: node tools/tracking.mjs ads-link   (prints PASS). Data can take up to 24 hours to show.');
}

// ---------- GTM account (no create API) ----------
async function gtmAccount() {
  const name = need(bizName(), 'Need --name "<Business>" (the exact Tag Manager account name).');
  const domain = need(bizDomain(), 'Need --domain example.com.');
  const accts = (await gtm('accounts')).account || [];
  const found = accts.find((a) => String(a.name).trim().toLowerCase() === name.toLowerCase());
  if (found) {
    saveConfig({ businessName: name, domain, gtmAccountId: found.accountId });
    console.log(`Tag Manager account "${found.name}" found: ${found.accountId}. Saved as gtmAccountId.`);
    return;
  }
  saveConfig({ businessName: name, domain });
  if (has('browser') || await botBrowser()) return gtmAccountBrowser(name, domain);
  console.log(`No Tag Manager account named "${name}" yet. Google has no API to create one, so this is a one-time 1 minute step:`);
  console.log('  1. Open https://tagmanager.google.com/#/admin/accounts/create (signed in to the same Google account).');
  console.log(`  2. Account name: ${name}`);
  console.log('  3. Country: United States');
  console.log(`  4. Container name: ${domain}`);
  console.log('  5. Target platform: Web. Click Create.');
  console.log('  6. Accept the Terms of Service (tick the data processing box, click Yes).');
  console.log(`  7. Then run: node tools/tracking.mjs gtm-account --name "${name}" --domain ${domain}`);
  console.log('Or let the bot do it in its own browser: node pack.mjs browser setup, then node pack.mjs browser login (one time), then run this again with --confirm.');
  process.exitCode = 1;
}

// The bot's own hidden Chrome (lib/browser.mjs). Ready = helper installed + Chrome found + signed in to Google.
async function botBrowser() {
  try { const b = await import('../lib/browser.mjs'); await b.playwright(); if (!b.chromePath()) return null; return b; } catch { return null; }
}

// Google has no API for this form, so the bot fills it in its own browser. Falls back to the manual steps.
async function gtmAccountBrowser(name, domain) {
  const b = await botBrowser();
  if (!b) die('The bot browser is not set up. Run: node pack.mjs browser setup, then node pack.mjs browser login (the owner signs in to Google once). Or use the manual steps (run gtm-account without --browser).', 2);
  if (!CONFIRM) { dry(`open Tag Manager in the bot's browser and create account "${name}" with web container "${domain}".`); console.log('Dry run. Add --confirm to do it.'); return; }
  try {
    await b.withPage(async (p) => {
    await p.goto('https://tagmanager.google.com/#/admin/accounts/create', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(9000);
    if (/accounts\.google\.com/.test(p.url())) throw new Error('the bot browser is not signed in to Google (run: node pack.mjs browser login)');
    await p.locator('input.wd-account-name').fill(name);
    await p.locator('input.wd-container-name').fill(domain);
    await p.getByText('For use on desktop and mobile web pages').click();
    await p.waitForTimeout(800);
    await p.getByRole('button', { name: 'Create', exact: true }).click();
    await p.waitForTimeout(6000);
    const dpa = p.locator('#acceptDpa');
    if (await dpa.isVisible().catch(() => false) && (await dpa.getAttribute('aria-checked')) !== 'true') await dpa.click();
    await p.getByRole('button', { name: 'Yes', exact: true }).click();
    await p.waitForTimeout(12000);
    });
  } catch (e) {
    console.error('Browser fill did not finish: ' + e.message + '. Use the manual steps (run gtm-account without --browser).');
    process.exitCode = 1;
  }
  for (let i = 0; i < 6; i++) {
    const a = ((await gtm('accounts')).account || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
    if (a) { saveConfig({ gtmAccountId: a.accountId }); console.log(`Tag Manager account created: ${a.accountId}. Saved.`); process.exitCode = 0; return; }
    await sleep(5000);
  }
  console.log('Account not visible yet. Run gtm-account again in a minute.');
}

// ---------- GTM container + locked template ----------
async function workspacePath(acct, cid) {
  const ws = (await gtm(`accounts/${acct}/containers/${cid}/workspaces`)).workspace || [];
  const w = ws.find((x) => x.name === 'Default Workspace') || ws[0];
  if (!w) throw new Error('this container has no workspace');
  return w.path;
}

async function publish(acct, cid, ws, versionName) {
  const ver = await gtm(`${ws}:create_version`, { method: 'POST', body: { name: versionName, notes: 'google-ads-pack tracking.mjs' } });
  const v = ver.containerVersion;
  if (!v) throw new Error('Tag Manager did not create a version' + (ver.compilerError ? ' (compiler error in the workspace)' : ''));
  await gtm(`accounts/${acct}/containers/${cid}/versions/${v.containerVersionId}:publish`, { method: 'POST' });
  return v.containerVersionId;
}

function installSnippets(pub) {
  console.log('\nPut this as high as possible in the <head> of every page:');
  console.log(`<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${pub}');</script>
<!-- End Google Tag Manager -->`);
  console.log('\nPut this right after the opening <body> tag of every page:');
  console.log(`<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${pub}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`);
}

async function container() {
  const c = config();
  const domain = need(bizDomain(), 'Need --domain example.com.');
  const acct = need(c.gtmAccountId, 'No Tag Manager account saved yet. Run: node tools/tracking.mjs gtm-account --name "<Business>" --domain <domain> first.');
  const mid = need(c.ga4MeasurementId, 'No GA4 Measurement ID saved yet. Run: node tools/tracking.mjs ga4-property first.');
  const clarityId = /^[a-z0-9]{6,20}$/i.test(c.clarityProjectId || '') ? c.clarityProjectId : '';

  const all = (await gtm(`accounts/${acct}/containers`)).container || [];
  let cont = all.find((x) => cleanDomain(x.name) === domain) || (all.length === 1 ? all[0] : null);
  if (!cont && all.length > 1) console.log(`This account has ${all.length} containers and none is named ${domain}. A new one will be made.`);
  if (cont && !(cont.usageContext || []).includes('web')) die(`Container "${cont.name}" is not a Web container. Rename it or make a web container named ${domain}.`, 2);

  if (!cont) {
    if (!CONFIRM) {
      dry(`create web container "${domain}", turn on ${BUILTINS.length} built-in variables, add tags ${TAG_LINKER} + ${TAG_GA4} (${mid})${clarityId ? ' + ' + TAG_CLARITY : ''} on All Pages, then publish.`);
      console.log('Dry run. Add --confirm to do it.'); return;
    }
    cont = await gtm(`accounts/${acct}/containers`, { method: 'POST', body: { name: domain, usageContext: ['web'] } });
    console.log(`Created container ${cont.publicId}.`);
  } else console.log(`Using container ${cont.publicId} "${cont.name}".`);
  const cid = cont.containerId;
  const ws = await workspacePath(acct, cid);

  // Plan the missing pieces.
  const enabled = new Set(((await gtm(`${ws}/built_in_variables`)).builtInVariable || []).map((b) => b.type));
  const missingVars = BUILTINS.filter((t) => !enabled.has(t));
  const tags = (await gtm(`${ws}/tags`)).tag || [];
  const hasTag = (name, test) => tags.some((t) => t.name === name || (test && test(t)));
  const wanted = [];
  if (!hasTag(TAG_LINKER, (t) => t.type === 'gclidw')) wanted.push({ name: TAG_LINKER, type: 'gclidw', firingTriggerId: [ALL_PAGES] });
  const ga4Tag = tags.find((t) => t.name === TAG_GA4 || (t.type === 'googtag' && (t.parameter || []).some((p) => p.key === 'tagId' && p.value === mid)));
  if (!ga4Tag) wanted.push({ name: TAG_GA4, type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: mid }], firingTriggerId: [ALL_PAGES] });
  if (clarityId && !hasTag(TAG_CLARITY, (t) => t.type === 'html' && JSON.stringify(t.parameter || []).includes('clarity.ms/tag'))) {
    wanted.push({ name: TAG_CLARITY, type: 'html', parameter: [{ type: 'template', key: 'html', value: claritySnippet(clarityId) }], firingTriggerId: [ALL_PAGES] });
  }
  let live = null; try { live = await gtm(`accounts/${acct}/containers/${cid}/versions:live`); } catch {}
  const changes = missingVars.length + wanted.length;

  if (missingVars.length) dry(`turn on ${missingVars.length} built-in variables.`);
  for (const t of wanted) dry(`add tag "${t.name}" (${t.type}) on All Pages.`);
  if (!clarityId) console.log('Note: no Clarity project saved yet, so no Clarity tag. Run tools/clarity.mjs setup, then this command again.');
  if (!changes && live) console.log('Template already in place and published. Nothing to change.');
  else if (CONFIRM) {
    if (missingVars.length) await gtm(`${ws}/built_in_variables?` + missingVars.map((t) => 'type=' + encodeURIComponent(t)).join('&'), { method: 'POST' });
    for (const t of wanted) await gtm(`${ws}/tags`, { method: 'POST', body: t });
    const vid = await publish(acct, cid, ws, `Standard tracking: ${domain}`);
    console.log(`Published container version ${vid}.`);
    log('tracking', `container ${cont.publicId} published v${vid} (${changes} changes)`);
  } else if (!changes) dry('publish the container for the first time.');
  saveConfig({ domain, gtmContainerId: cid, gtmPublicId: cont.publicId });
  if (!CONFIRM && (changes || !live)) { console.log('Dry run. Add --confirm to do it.'); return; }
  installSnippets(cont.publicId);
  console.log(`\nThen check it: node tools/tracking.mjs verify --url https://${domain}/`);
}

// ---------- verify the site has the GTM code ----------
async function verify() {
  const url = need(arg('url') || (config().domain && `https://${config().domain}/`), 'Need --url https://example.com/');
  const pub = config().gtmPublicId;
  let html;
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (tracking check)' } });
    html = await r.text();
    if (!r.ok) console.log(`Note: the page answered HTTP ${r.status}.`);
  } catch (e) { die(`Could not load ${url}: ${e.message}`, 1); }
  const ids = [...new Set(html.match(/GTM-[A-Z0-9]{4,10}/g) || [])];
  if (!pub) { console.log(ids.length ? `Found GTM ids on the page: ${ids.join(', ')} (no container saved in config to compare).` : 'No GTM code found on the page.'); return; }
  const ok = ids.includes(pub);
  const head = ok && /<head[\s\S]*?gtm\.js\?id=/i.test(html.split(/<\/head>/i)[0] + '</head>');
  const body = ok && new RegExp('ns\\.html\\?id=' + pub).test(html);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${pub} on ${url}`);
  if (ok) { console.log(`  head script: ${head ? 'yes' : 'not found in <head> (it may be added by a plugin later in the page)'}`); console.log(`  body noscript: ${body ? 'yes' : 'no (add the body snippet too)'}`); }
  const others = ids.filter((x) => x !== pub);
  if (others.length) console.log(`  Also found other containers: ${others.join(', ')}. Make sure that is on purpose.`);
  if (!ok) process.exitCode = 1;
}

// ---------- Google Ads conversions ----------
function cleanPath(p) {
  const raw = String(p || '').trim();
  const m = raw.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  const host = m ? m[1].toLowerCase() : '';
  let path = m ? (m[2] || '/') : raw;
  if (!path.startsWith('/')) path = '/' + path;
  return { host, path };
}

function convPlan() {
  const goal = String(arg('goal', 'both')).toLowerCase();
  if (!['optin', 'booked', 'both'].includes(goal)) die('--goal must be optin, booked or both.', 2);
  const list = [];
  if (goal !== 'booked') {
    const o = cleanPath(need(arg('optin-path'), 'Need --optin-path (the page people land on after the opt-in form, e.g. /thank-you-optin).'));
    list.push({ key: 'optin', name: 'Opt In', category: 'SIGNUP', ...o, primary: goal === 'optin' });
  }
  if (goal !== 'optin') {
    const b = cleanPath(need(arg('booked-path'), 'Need --booked-path (the page people land on after booking, e.g. /thank-you-booked).'));
    list.push({ key: 'booked', name: 'Booked Call', category: 'BOOK_APPOINTMENT', ...b, primary: true });
  }
  for (const it of list) if (it.path === '/' || it.path.length < 2) die(`Refusing "${it.path}" for ${it.name}: it would fire on every page. Use the thank-you page path.`, 2);
  if (list.length === 2 && (list[0].path.startsWith(list[1].path) || list[1].path.startsWith(list[0].path)) && list[0].host === list[1].host)
    die(`The two paths overlap ("${list[0].path}" and "${list[1].path}"), so one page would fire both conversions. Use two different thank-you pages.`, 2);
  return list;
}

async function adsLib() { return import('../lib/ads.mjs'); }

async function findAction(name) {
  const { search } = await adsLib();
  const q = `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.primary_for_goal, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.name = '${String(name).replace(/[\r\n\\]/g, ' ').replace(/'/g, "\\'")}' AND conversion_action.status != 'REMOVED'`;
  return (await search(q))[0]?.conversionAction || null;
}
function idLabel(action) {
  for (const s of action?.tagSnippets || []) {
    const m = String(s.eventSnippet || '').match(/send_to'?\s*:\s*'AW-(\d+)\/([^']+)'/);
    if (m) return { conversionId: m[1], label: m[2] };
  }
  return null;
}

async function ensureAction(p) {
  const { mutate } = await adsLib();
  let a = await findAction(p.name);
  if (a) {
    if (Boolean(a.primaryForGoal) !== p.primary) {
      await mutate('conversionActions', [{ update: { resourceName: a.resourceName, primaryForGoal: p.primary }, updateMask: 'primary_for_goal' }], { validateOnly: !CONFIRM });
      console.log(`${CONFIRM ? 'SET' : 'WOULD SET'} "${p.name}" to ${p.primary ? 'Primary' : 'Secondary'}.`);
    } else console.log(`Ads conversion "${p.name}" already exists (id ${a.id}). Reusing it.`);
  } else {
    const create = {
      name: p.name, category: p.category, type: 'WEBPAGE', status: 'ENABLED', primaryForGoal: p.primary,
      countingType: 'ONE_PER_CLICK',
      valueSettings: { defaultValue: 0, alwaysUseDefaultValue: true },
      clickThroughLookbackWindowDays: 30, viewThroughLookbackWindowDays: 1,
    };
    await mutate('conversionActions', [{ create }], { validateOnly: !CONFIRM });
    console.log(`${CONFIRM ? 'CREATED' : 'CHECKED OK (dry run, Google validated it)'} Ads conversion "${p.name}": ${p.category}, ${p.primary ? 'Primary' : 'Secondary'}, count one, no value.`);
    if (!CONFIRM) return null;
    for (let i = 0; i < 4 && !idLabel(a); i++) { a = await findAction(p.name); if (!idLabel(a)) await sleep(3000); }
  }
  const il = idLabel(a);
  if (!il) throw new Error(`Google Ads has no tag snippet for "${p.name}" yet. Run conversions again in a minute.`);
  return il;
}

function trigBody(it) {
  const f = [{ type: 'contains', parameter: [{ type: 'template', key: 'arg0', value: '{{Page URL}}' }, { type: 'template', key: 'arg1', value: it.path }] }];
  if (it.host) f.push({ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{Page Hostname}}' }, { type: 'template', key: 'arg1', value: it.host }] });
  return { name: `${it.name} - thank-you page`, type: 'pageview', filter: f };
}

async function conversions() {
  const c = config();
  const items = convPlan();
  const acct = need(c.gtmAccountId, 'No Tag Manager account saved yet. Run the container step first.');
  const cid = need(c.gtmContainerId, 'No container saved yet. Run: node tools/tracking.mjs container --domain <domain> --confirm first.');

  // With only Opt In asked for, it stays Secondary if a Booked Call already exists (one Primary per funnel).
  if (items.length === 1 && items[0].key === 'optin' && await findAction('Booked Call')) items[0].primary = false;
  for (const it of items) console.log(`${it.name}: ${it.category}, ${it.primary ? 'PRIMARY (campaigns bid on it)' : 'SECONDARY (watched only)'}, fires when Page URL contains "${it.path}"${it.host ? ' on ' + it.host : ''}.`);

  for (const it of items) Object.assign(it, (await ensureAction(it)) || { conversionId: 'AW_ID', label: 'LABEL' });

  const ws = await workspacePath(acct, cid);
  const tags = (await gtm(`${ws}/tags`)).tag || [], trigs = (await gtm(`${ws}/triggers`)).trigger || [];
  const todo = [];
  if (!tags.some((t) => t.type === 'gclidw')) todo.push({ kind: 'linker' });
  for (const it of items) {
    if (tags.some((t) => t.name === it.name)) { console.log(`GTM tag "${it.name}" already there. Left as is (conversions-verify checks it).`); continue; }
    todo.push({ kind: 'conv', it, trig: trigs.find((t) => t.name === trigBody(it).name) });
  }
  for (const t of todo) dry(t.kind === 'linker' ? `add tag "${TAG_LINKER}" on All Pages.` : `add trigger "${trigBody(t.it).name}" and tag "${t.it.name}" (Google Ads Conversion Tracking, AW-${t.it.conversionId}/${t.it.label}).`);
  if (!todo.length) { console.log('Tag Manager already has everything. Nothing to publish.'); return; }
  if (!CONFIRM) { console.log('Dry run. Add --confirm to create the conversions and publish.'); return; }
  for (const t of todo) {
    if (t.kind === 'linker') { await gtm(`${ws}/tags`, { method: 'POST', body: { name: TAG_LINKER, type: 'gclidw', firingTriggerId: [ALL_PAGES] } }); continue; }
    const trig = t.trig || await gtm(`${ws}/triggers`, { method: 'POST', body: trigBody(t.it) });
    await gtm(`${ws}/tags`, { method: 'POST', body: { name: t.it.name, type: 'awct', firingTriggerId: [trig.triggerId], parameter: [
      { type: 'template', key: 'conversionId', value: t.it.conversionId },
      { type: 'template', key: 'conversionLabel', value: t.it.label },
      { type: 'boolean', key: 'enableConversionLinker', value: 'true' }] } });
  }
  const vid = await publish(acct, cid, ws, 'Ads conversions: ' + items.map((i) => i.name).join(' + '));
  log('tracking', `conversions published v${vid}: ${items.map((i) => i.name).join(', ')}`);
  console.log(`Published container version ${vid}. Now run conversions-verify.`);
}

async function conversionsVerify() {
  const c = config();
  const acct = need(c.gtmAccountId, 'No Tag Manager account saved yet.');
  const cid = need(c.gtmContainerId, 'No container saved yet.');
  const site = String(arg('site') || (c.domain ? 'https://' + c.domain : '')).replace(/\/+$/, '');
  const checks = [];
  if (arg('optin-path')) checks.push({ name: 'Opt In', ...cleanPath(arg('optin-path')) });
  if (arg('booked-path')) checks.push({ name: 'Booked Call', ...cleanPath(arg('booked-path')) });
  if (!checks.length) die('Need --optin-path and/or --booked-path.', 2);

  let live;
  try { live = await gtm(`accounts/${acct}/containers/${cid}/versions:live`); }
  catch (e) { die('Could not read the published container (' + e.message + '). Has it been published?', 1); }
  const tags = live.tag || [], trigs = live.trigger || [];
  let ok = true;
  const line = (pass, msg) => { console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`); if (!pass) ok = false; };

  line(tags.some((t) => t.type === 'gclidw' && (t.firingTriggerId || []).includes(ALL_PAGES)), 'Conversion Linker fires on All Pages');
  for (const t of tags.filter((x) => x.type === 'awct')) line(!(t.firingTriggerId || []).includes(ALL_PAGES), `Ads tag "${t.name}" is not on All Pages`);
  for (const ch of checks) {
    const tag = tags.find((t) => t.name === ch.name && t.type === 'awct');
    if (!tag) { line(false, `"${ch.name}" Google Ads conversion tag is published`); continue; }
    const fired = (tag.firingTriggerId || []).map((id) => trigs.find((t) => t.triggerId === id)).filter(Boolean);
    const good = fired.length > 0 && fired.length === (tag.firingTriggerId || []).length && fired.every((t) => t.type === 'pageview' &&
      (t.filter || []).some((f) => f.type === 'contains' && (f.parameter || []).some((p) => p.key === 'arg1' && p.value === ch.path)));
    line(good, `"${ch.name}" fires only on Page View where Page URL contains "${ch.path}"`);
    const hasId = (tag.parameter || []).some((p) => p.key === 'conversionId' && /^\d+$/.test(p.value)) && (tag.parameter || []).some((p) => p.key === 'conversionLabel' && p.value && p.value !== 'LABEL');
    line(hasId, `"${ch.name}" has a real conversion id and label`);
  }
  if (site && c.gtmPublicId) {
    try {
      const html = await (await fetch(site + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (tracking check)' } })).text();
      line(html.includes(c.gtmPublicId), `${site}/ has ${c.gtmPublicId} installed`);
    } catch (e) { line(false, `could not load ${site}/ (${e.message})`); }
  }
  console.log(ok ? 'VERIFY PASS' : 'VERIFY FAIL');
  if (ok) saveConfig({ conversionsDone: { checked: new Date().toISOString(), conversions: checks.map((x) => x.name) } });
  console.log('Last check by eye: open Tag Manager Preview on the home page (the conversion must not fire) and on each thank-you page (it must fire).');
  if (!ok) process.exitCode = 1;
}

// ---------- run ----------
const COMMANDS = { 'ga4-account': ga4Account, 'ga4-property': ga4Property, 'ads-link': adsLink, 'gtm-account': gtmAccount, container, verify, conversions, 'conversions-verify': conversionsVerify };
if (!COMMANDS[cmd]) {
  console.log('Usage: node tools/tracking.mjs <command>\n  ' + Object.keys(COMMANDS).join('\n  ') + '\nSee the top of this file for flags.');
  process.exit(cmd ? 2 : 0);
}
try { await COMMANDS[cmd](); }
catch (e) { console.error('ERROR ' + (e.message || e)); process.exitCode = 1; }
