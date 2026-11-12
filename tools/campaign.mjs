#!/usr/bin/env node
/*
 * campaign.mjs: a careful campaign builder. It never spends: everything is built PAUSED, and turning it on needs the owner's yes.
 * Run it through: node pack.mjs campaign <plan|create> ...
 *
 *   plan   --goal booked|optin|sales --type search|pmax --budget <daily dollars> --geo "<place>[; <place>]" \
 *          --keywords "a,b,c" --landing <https url> [--name "..."] [options]
 *   create ...same flags... --confirm        builds it in Google Ads, PAUSED
 *
 * Options:
 *   --radius <miles>            target a radius around --geo (a ZIP code or "City, ST"), or around --lat/--lng
 *   --headlines "a|b|c"         up to 15, 30 characters each (drafted from config.json if left out; review them)
 *   --descriptions "a|b"        up to 4, 90 characters each
 *   --long-headlines "a|b"      PMax: up to 5, 90 characters each
 *   --business-name "..."       PMax: 25 characters max (default config.businessName)
 *   --themes "a,b"              PMax search themes (default = --keywords)
 *   --logo f.png --landscape a.jpg,b.jpg --square c.jpg [--portrait d.jpg]   PMax images (files on this computer)
 *   --schedule "MON-FRI 8-18"   ad schedule (default: all hours)
 *   --country US --language 1000 (English)   --no-goal (allow a build with no matching conversion action: not advised)
 *
 *
 * The campaign setup we teach (skills/google-ads-campaign-setup/SKILL.md), built in:
 *   --sheet <link>              read YOUR copy of the Google Ad Template (keywords, ad groups, 15 headlines, 4 descriptions,
 *                               sitelinks, callouts, phone, structured snippets, standard/industry/company negatives).
 *                               Make the copy first: node pack.mjs campaign template
 *   --plan plan.json            the same plan as a file (shape: node pack.mjs campaign template --json)
 *   --bidding clicks|conversions   Search default: clicks (Maximize Clicks) with a max cost per click of --max-cpc (default $10)
 *   --max-cpc <dollars>         the highest bid per click (default config.maxCpc or 10). Budget should buy 5 to 10 clicks a day.
 *   --broad "a long keyword"    one broad keyword per ad group, 4 or more words (everything else is exact match)
 *   --sitelinks "Text|https://url|desc 1|desc 2;;Text 2|..."   2 to 4 (text 25, descriptions 35 characters)
 *   --callouts "a|b|c"          up to 10 (25 characters each)
 *   --snippets "a|b|c"          Service catalog values, 3 to 10 (25 characters each)
 *   --phone "+1 555 555 5555"   call asset so people can call from the ad
 *   --audiences "name|name"     in-market / interest audiences on OBSERVATION only (tracks data, never narrows the ad)
 *   --start monday|today|YYYY-MM-DD   default: the next Monday   --end YYYY-MM-DD (only when the budget has a hard stop)
 *   --negatives-extra "a,b"     more broad negatives (industry and competitor names)
 *
 * Rules built in: Google Search only (no Display, no search partners). Presence targeting (people IN the area).
 * One conversion goal per campaign. Exact match buyer keywords plus at most one long broad keyword per ad group
 * (informational keywords are refused). Standard + industry + company negatives attached. Built PAUSED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACK, DATA, argv, arg, has, config, secret, readJSON, writeJSON, log, today } from '../lib/core.mjs';
import { adsApi, search, customerId, dateRange } from '../lib/ads.mjs';
import { classifyTerm, guardNegative, norm, toks } from '../lib/classify.mjs';
import { explain } from './ads.mjs';
import { parseCsv, planFromTabs, sheetId, tabCsvUrl, TABS, TEMPLATE_COPY_URL } from '../lib/plan-sheet.mjs';

const A = argv[0] === 'campaign' ? argv.slice(1) : argv;
const cmd = A[0];
const list = (v, sep = ',') => String(v || '').split(sep).map((s) => s.trim()).filter(Boolean);
const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const DAYS = { MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY', FRI: 'FRIDAY', SAT: 'SATURDAY', SUN: 'SUNDAY' };
const DAY_KEYS = Object.keys(DAYS);
const GOALS = {
  booked: { re: /book|call|appoint|schedul|consult|meeting/i, cats: ['BOOK_APPOINTMENT', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD'], prefer: /booked call/i, cta: 'Book Your Call Today' },
  optin: { re: /opt.?in|lead|sign.?up|subscribe|form|register|download/i, cats: ['SUBMIT_LEAD_FORM', 'SIGNUP', 'CONTACT', 'DOWNLOAD'], prefer: /opt.?in/i, cta: 'Get Instant Access' },
  sales: { re: /purchase|sale|order|checkout|buy/i, cats: ['PURCHASE'], prefer: /purchase/i, cta: 'Order Online Today' },
};

// ---------- pure checks (exported for tests) ----------
export function checkRsa(headlines, descriptions, { minH = 3, maxH = 15, maxHLen = 30, minD = 2, maxD = 4, maxDLen = 90 } = {}) {
  const e = [];
  if (headlines.length < minH) e.push(`need at least ${minH} headlines, have ${headlines.length}`);
  if (headlines.length > maxH) e.push(`at most ${maxH} headlines, have ${headlines.length}`);
  if (descriptions.length < minD) e.push(`need at least ${minD} descriptions, have ${descriptions.length}`);
  if (descriptions.length > maxD) e.push(`at most ${maxD} descriptions, have ${descriptions.length}`);
  for (const h of headlines) { if (h.length > maxHLen) e.push(`headline over ${maxHLen} chars (${h.length}): "${h}"`); if (/!/.test(h)) e.push(`headline may not use "!": "${h}"`); }
  for (const d of descriptions) if (d.length > maxDLen) e.push(`description over ${maxDLen} chars (${d.length}): "${d}"`);
  for (const t of [...headlines, ...descriptions]) {
    if (/[\u2013\u2014]/.test(t)) e.push(`no long dashes: "${t}"`);
    if (/\b[A-Z]{5,}\b/.test(t)) e.push(`no ALL CAPS words (Google policy): "${t}"`);
    if (/!!|\?\?|\s{2,}/.test(t)) e.push(`repeated punctuation or double space: "${t}"`);
  }
  const dup = (a) => a.filter((x, i) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  for (const d of [...dup(headlines), ...dup(descriptions)]) e.push(`duplicate text: "${d}"`);
  return e;
}
export function checkKeywords(kws, ctx = {}) {
  const ok = [], refused = [], warn = [];
  for (const k of kws.map(norm).filter(Boolean)) {
    const c = classifyTerm(k, { competitors: ctx.competitors || [], offNiche: ctx.offNiche || [], protect: [], targets: [] });
    if (c) refused.push(`${k}: ${c.category} (${c.reason})`);
    else { ok.push(k); if (toks(k).length === 1) warn.push(`"${k}" is one word: very broad, often not a buyer search`); if (toks(k).length > 10) refused.push(`${k}: more than 10 words`); }
  }
  return { ok: ok.filter((k) => toks(k).length <= 10), refused, warn };
}
// Drafts from config. The bot should replace these with better copy (--headlines/--descriptions); they always pass the length check.
export function draftCopy(c, kws, geoLabel, goal) {
  const city = (geoLabel || '').split(/[;,]/)[0].trim();
  const svc = (c.services || [])[0] || kws[0] || '';
  const name = c.businessName || '';
  const cta = GOALS[goal]?.cta || 'Get Started Today';
  const H = [
    ...kws.slice(0, 5).map(titleCase),
    city && kws[0] && !norm(kws[0]).includes(norm(city)) && `${titleCase(kws[0])} ${city}`,
    name, name && `${name} Official Site`,
    cta, 'Talk to a Real Person', 'See How We Can Help',
    city && `Serving ${city}`, city && svc && `${titleCase(svc)} in ${city}`,
    svc && `Trusted ${titleCase(svc)}`, c.phone && `Call ${c.phone}`,
  ].filter((h) => h && h.length <= 30);
  const D = [
    name && svc && `${name} helps with ${svc}${city ? ' in ' + city : ''}. ${cta}.`,
    (c.business || '').replace(/\s+/g, ' ').trim(),
    `${cta}. Clear answers, real people, and a plan that fits you.`,
    (c.services || []).length > 1 && `We offer ${(c.services || []).slice(0, 3).join(', ')}. Reach out today.`,
  ].filter((d) => d && d.length <= 90);
  const uniq = (a) => a.filter((x, i) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  return { headlines: uniq(H).slice(0, 15), descriptions: uniq(D).slice(0, 4) };
}
export function parseSchedule(s) {
  if (!s) return [];
  const m = /^([A-Z]{3})(?:-([A-Z]{3}))?\s+(\d{1,2})-(\d{1,2})$/i.exec(s.trim());
  if (!m) throw new Error('--schedule must look like "MON-FRI 8-18"');
  const a = DAY_KEYS.indexOf(m[1].toUpperCase()), b = DAY_KEYS.indexOf((m[2] || m[1]).toUpperCase()), sh = +m[3], eh = +m[4];
  if (a < 0 || b < a || !(sh >= 0 && eh <= 24 && sh < eh)) throw new Error('bad --schedule ' + s);
  return DAY_KEYS.slice(a, b + 1).map((d) => ({ dayOfWeek: DAYS[d], startHour: sh, endHour: eh, startMinute: 'ZERO', endMinute: 'ZERO' }));
}
// Width x height from a PNG or JPEG header (no packages).
export function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(1, 4).toString() === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const t = b[i + 1], len = b.readUInt16BE(i + 2);
      if (t >= 0xc0 && t <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(t)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), bytes: b.length }; i += 2 + len; }
  }
  return { w: 0, h: 0, bytes: b.length };
}
const IMG = { LOGO: { ratio: 1, min: [128, 128] }, SQUARE_MARKETING_IMAGE: { ratio: 1, min: [300, 300] }, MARKETING_IMAGE: { ratio: 1.91, min: [600, 314] }, PORTRAIT_MARKETING_IMAGE: { ratio: 0.8, min: [480, 600] } };
export function checkImage(file, field) {
  if (!fs.existsSync(file)) return `${field}: file not found ${file}`;
  const s = imageSize(file), spec = IMG[field];
  if (!s.w) return `${field}: ${path.basename(file)} is not a PNG or JPEG`;
  if (s.bytes > 5e6) return `${field}: ${path.basename(file)} is over 5 MB`;
  if (Math.abs(s.w / s.h - spec.ratio) > 0.02) return `${field}: ${path.basename(file)} is ${s.w}x${s.h}, needs a ${spec.ratio}:1 shape`;
  if (s.w < spec.min[0] || s.h < spec.min[1]) return `${field}: ${path.basename(file)} is ${s.w}x${s.h}, needs at least ${spec.min.join('x')}`;
  return null;
}

// Policy-style text checks shared by every asset (no long dashes, no ALL CAPS words, no repeated punctuation).
function textRules(t, what) {
  const e = [];
  if (/[\u2013\u2014]/.test(t)) e.push(`${what}: no long dashes: "${t}"`);
  if (/\b[A-Z]{5,}\b/.test(t)) e.push(`${what}: no ALL CAPS words: "${t}"`);
  if (/!!|\?\?|\s{2,}/.test(t)) e.push(`${what}: repeated punctuation or double space: "${t}"`);
  return e;
}
export function checkAssets({ sitelinks = [], callouts = [], snippets = [], phone = '' }, landing = '') {
  const e = [], w = [];
  if (sitelinks.length && sitelinks.length < 2) e.push('sitelinks: Google shows them only with 2 or more');
  if (sitelinks.length > 4) w.push(`sitelinks: ${sitelinks.length} given, the setup uses 2 to 4 (extra ones are kept)`);
  if (!sitelinks.length) w.push('no sitelinks: the setup adds 2 to 4 (--sitelinks or the sheet). The ad will be smaller.');
  for (const s of sitelinks) {
    if (!s.text || s.text.length > 25) e.push(`sitelink text must be 1 to 25 characters: "${s.text}"`);
    if (!/^https:\/\//.test(s.url || landing)) e.push(`sitelink "${s.text}" needs an https:// address`);
    if (!s.description1 || !s.description2) e.push(`sitelink "${s.text}" needs 2 descriptions (35 characters each)`);
    for (const d of [s.description1, s.description2]) if (d && d.length > 35) e.push(`sitelink description over 35 characters (${d.length}): "${d}"`);
    for (const t of [s.text, s.description1, s.description2]) if (t) e.push(...textRules(t, 'sitelink'));
  }
  if (!callouts.length) w.push('no callouts: the setup adds about 10 (--callouts or the sheet)');
  if (callouts.length > 20) e.push(`at most 20 callouts, have ${callouts.length}`);
  for (const t of callouts) { if (t.length > 25) e.push(`callout over 25 characters (${t.length}): "${t}"`); e.push(...textRules(t, 'callout')); }
  if (snippets.length && snippets.length < 3) e.push('structured snippets need at least 3 values');
  if (!snippets.length) w.push('no structured snippets: the setup lists the services as a "Service catalog"');
  if (snippets.length > 10) e.push(`at most 10 structured snippet values, have ${snippets.length}`);
  for (const t of snippets) { if (t.length > 25) e.push(`snippet value over 25 characters (${t.length}): "${t}"`); e.push(...textRules(t, 'snippet')); }
  if (phone && !/^\+?[\d\s().-]{7,20}$/.test(phone)) e.push(`phone does not look like a phone number: "${phone}"`);
  if (!phone) w.push('no phone number: the setup adds a call asset so people can call from the ad (--phone)');
  const dup = (a) => a.filter((x, i) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  for (const d of [...dup(callouts), ...dup(snippets), ...dup(sitelinks.map((s) => s.text))]) e.push(`duplicate asset text: "${d}"`);
  return { errors: e, warn: w };
}
// One broad keyword per ad group, 4+ words (the long-tail broad hack); everything else exact.
export function checkBroad(broad) {
  const e = [], w = [];
  if (broad.length > 1) e.push(`only 1 broad keyword per ad group (have ${broad.length}: ${broad.join(', ')}). Use exact match for the rest.`);
  for (const b of broad) if (toks(b).length < 4) e.push(`broad keyword "${b}" is ${toks(b).length} words: a broad keyword must be 4 or more words so it stays bottom of funnel`);
  return { errors: e, warn: w };
}
export function nextMonday(from = new Date()) {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const add = (8 - d.getUTCDay()) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10);
}
export function campaignName(niche, startIso) {
  const d = new Date(startIso + 'T12:00:00Z');
  return `${titleCase(niche || 'Campaign')} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(',', '')}`;
}
export function parseSitelinks(s) {
  return list(s, ';;').map((x) => { const [text, url, description1, description2] = x.split('|').map((y) => (y || '').trim()); return { text, url, description1, description2 }; });
}

// Read the owner's copy of the template: public link first, then the bot's own signed-in Chrome for a private copy.
async function fetchTab(id, tab) {
  const url = tabCsvUrl(id, tab);
  const looksCsv = (t) => t && !/^\s*</.test(t) && /,/.test(t);
  try { const r = await fetch(url, { redirect: 'follow' }); const t = await r.text(); if (r.ok && looksCsv(t)) return t; } catch {}
  const { withPage } = await import('../lib/browser.mjs');
  const t = await withPage(async (page) => { await page.goto(`https://docs.google.com/spreadsheets/d/${id}/edit`, { waitUntil: 'domcontentloaded' }); const r = await page.request.get(url); return r.ok() ? r.text() : ''; });
  if (!looksCsv(t)) throw new Error(`could not read the "${tab}" tab. Share your copy with the Google account signed in to the bot's browser (node pack.mjs browser login), or make it "anyone with the link can view".`);
  return t;
}
async function loadPlan() {
  if (arg('plan')) { const j = readJSON(arg('plan')); if (!j) throw new Error('--plan file is missing or not valid JSON'); return j; }
  if (!arg('sheet')) return null;
  const id = sheetId(arg('sheet'));
  if (id === sheetId(TEMPLATE_COPY_URL)) throw new Error(`that is the master template. Make your own copy first: ${TEMPLATE_COPY_URL}`);
  return planFromTabs(parseCsv(await fetchTab(id, arg('kw-tab', TABS.keywords))), parseCsv(await fetchTab(id, arg('ads-tab', TABS.ads))));
}

// ---------- build the plan ----------
async function readInputs() {
  const c = config();
  let sheet = null; const errors = [], warn = [];
  try { sheet = await loadPlan(); } catch (e) { errors.push('plan: ' + e.message); }
  const S = sheet || {};
  const goal = arg('goal'), type = arg('type', 'search'), landing = arg('landing', '');
  const maxCpc = Number(arg('max-cpc', c.maxCpc || 10));
  const bidding = arg('bidding', type === 'search' ? 'clicks' : 'conversions');
  const budget = Number(arg('budget', ''));
  if (!GOALS[goal]) errors.push('--goal must be booked, optin or sales');
  if (!['search', 'pmax'].includes(type)) errors.push('--type must be search or pmax');
  if (!['clicks', 'conversions'].includes(bidding)) errors.push('--bidding must be clicks or conversions');
  if (type === 'pmax' && bidding === 'clicks') errors.push('Performance Max cannot bid for clicks: use --bidding conversions (the default for PMax)');
  if (!(maxCpc > 0 && maxCpc <= 1000)) errors.push('--max-cpc must be a dollar amount, for example 10');
  if (!(budget > 0)) errors.push(`--budget <daily dollars> needed. The rule: average cost per click x 5 clicks a day (at a $${maxCpc} max click: $${maxCpc * 5}/day)`);
  else if (budget < maxCpc * 5) warn.push(`$${budget}/day buys fewer than 5 clicks a day at up to $${maxCpc} a click. The setup wants 5 to 10 clicks a day ($${maxCpc * 5} to $${maxCpc * 10}/day), or lower keyword costs.`);
  if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(landing)) errors.push('--landing must be a full https:// address of the page where people book, opt in or buy (the local page for this area)');
  if (!arg('geo') && !(arg('lat') && arg('lng'))) errors.push('--geo "<city, state>" (or a ZIP with --radius) needed: never run ads to the whole country by accident');
  const geoLabel = arg('geo', '');
  // Ad groups: from the sheet/plan, or one group from the flags.
  const srcGroups = (S.adGroups && S.adGroups.length) ? S.adGroups : [{ name: arg('ad-group', ''), exact: list(arg('keywords')), broad: arg('broad') ? [arg('broad')] : [], headlines: arg('headlines') ? list(arg('headlines'), '|') : null, descriptions: arg('descriptions') ? list(arg('descriptions'), '|') : null }];
  const adGroups = srcGroups.map((g, i) => {
    const kw = checkKeywords((g.exact || []).map((k) => k.replace(/^[\["]|[\]"]$/g, '')), c);
    const br = checkKeywords((g.broad || []).map((k) => k.replace(/^[\["]|[\]"]$/g, '')), c);
    const label = g.name || `Ad Group ${i + 1}`;
    if (!kw.ok.length) errors.push(`${label}: exact match keywords needed (buyer keywords only, for example "emergency plumber denver")`);
    [...kw.refused, ...br.refused].forEach((r) => errors.push(`${label}: keyword refused, informational or not a buyer search: ${r}`)); warn.push(...kw.warn.map((w) => `${label}: ${w}`));
    const b = checkBroad(br.ok); errors.push(...b.errors.map((e) => `${label}: ${e}`));
    const draft = draftCopy(c, kw.ok, geoLabel, goal);
    const headlines = g.headlines && g.headlines.length ? g.headlines : draft.headlines;
    const descriptions = g.descriptions && g.descriptions.length ? g.descriptions : draft.descriptions;
    if (headlines.length < 15) warn.push(`${label}: ${headlines.length} headlines. The setup uses all 15 so Google can find the winner.`);
    if (descriptions.length < 4) warn.push(`${label}: ${descriptions.length} descriptions. The setup uses all 4.`);
    return { name: label, exact: kw.ok, broad: br.ok, headlines, descriptions, drafted: !(g.headlines && g.headlines.length && g.descriptions && g.descriptions.length) };
  });
  const keywords = adGroups.flatMap((g) => [...g.exact, ...g.broad]);
  const niche = arg('niche', S.niche || (c.services || [])[0] || adGroups[0]?.exact[0] || c.businessName || 'Campaign');
  let start = arg('start', 'monday');
  if (start === 'monday') start = nextMonday(); else if (start === 'today') start = today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) errors.push('--start must be monday, today or YYYY-MM-DD');
  else if (start < today()) errors.push('--start is in the past');
  const end = arg('end', '');
  if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start)) errors.push('--end must be YYYY-MM-DD after the start date');
  const name = arg('name') || campaignName(niche, start);
  let schedule = []; try { schedule = parseSchedule(arg('schedule')); } catch (e) { errors.push(e.message); }
  const assets = {
    sitelinks: (arg('sitelinks') ? parseSitelinks(arg('sitelinks')) : (S.sitelinks || [])).map((s) => ({ ...s, url: /^https:\/\//.test(s.url || '') ? s.url : landing })),
    callouts: arg('callouts') ? list(arg('callouts'), '|') : (S.callouts || []),
    snippetHeader: 'Service catalog',
    snippets: arg('snippets') ? list(arg('snippets'), '|') : (S.snippets && S.snippets.length ? S.snippets : (S.services || c.services || []).filter((s) => s.length <= 25).slice(0, 10)),
    phone: arg('phone', S.phone || c.phone || ''),
  };
  const ac = checkAssets(assets, landing); errors.push(...ac.errors); warn.push(...ac.warn);
  const audiences = list(arg('audiences', (c.audiences || []).join('|')), '|');
  if (type === 'search' && !audiences.length) warn.push('no observation audiences: add 2 to 5 in-market or interest topics for this industry with --audiences "a|b" (data only, never narrows who sees the ad)');
  const headlines = adGroups[0]?.headlines || [], descriptions = adGroups[0]?.descriptions || [];
  const p = { name, niche, goal, type, budget, maxCpc, bidding, landing, geoLabel, radius: arg('radius') ? Number(arg('radius')) : null, adGroups, keywords, headlines, descriptions,
    drafted: adGroups.some((g) => g.drafted), schedule, start, end, assets, audiences, extraNegatives: [...(S.negatives?.industry || []), ...(S.negatives?.company || []), ...list(arg('negatives-extra')).map((w) => w.toLowerCase())],
    sheetStandard: S.negatives?.standard || [], country: arg('country', 'US'), language: arg('language', '1000') };
  if (type === 'search') for (const g of adGroups) errors.push(...checkRsa(g.headlines, g.descriptions).map((e) => `${g.name}: ${e}`));
  else {
    p.longHeadlines = arg('long-headlines') ? list(arg('long-headlines'), '|') : [descriptions[0]].filter((d) => d && d.length <= 90);
    p.businessName = arg('business-name', c.businessName || '');
    p.themes = arg('themes') ? list(arg('themes')).map(norm) : keywords.slice(0, 25);
    p.images = { LOGO: list(arg('logo')), MARKETING_IMAGE: list(arg('landscape')), SQUARE_MARKETING_IMAGE: list(arg('square')), PORTRAIT_MARKETING_IMAGE: list(arg('portrait')) };
    errors.push(...checkRsa(headlines, descriptions, { minH: 3, maxH: 15, minD: 2, maxD: 5 }));
    if (!descriptions.some((d) => d.length <= 60)) errors.push('PMax needs at least one description of 60 characters or less');
    if (!p.longHeadlines.length) errors.push('PMax needs at least 1 long headline (90 characters max): --long-headlines "..."');
    p.longHeadlines.forEach((h) => h.length > 90 && errors.push(`long headline over 90 chars: "${h}"`));
    if (!p.businessName) errors.push('PMax needs a business name: --business-name "..." (25 characters max)');
    else if (p.businessName.length > 25) errors.push(`business name over 25 characters: "${p.businessName}"`);
    const missing = [];
    if (!p.images.LOGO.length) missing.push('1 square logo (1:1, at least 128x128, PNG or JPEG): --logo logo.png');
    if (!p.images.MARKETING_IMAGE.length) missing.push('1 or more landscape images (1.91:1, at least 600x314; 1200x628 is best): --landscape a.jpg,b.jpg');
    if (!p.images.SQUARE_MARKETING_IMAGE.length) missing.push('1 or more square images (1:1, at least 300x300; 1200x1200 is best): --square c.jpg');
    if (missing.length) errors.push('PMax is missing images the owner must provide:\n    - ' + missing.join('\n    - '));
    for (const [f, files] of Object.entries(p.images)) for (const file of files) { const e = checkImage(file, f); if (e) errors.push(e); }
    if (!p.themes.length) errors.push('PMax needs search themes: --themes "a,b"');
  }
  p.negatives = standardFor(p, c);
  return { p, errors, warn, c };
}
function standardFor(p, c) {
  const pack = (readJSON(path.join(PACK, 'data', 'standard-negatives.json'), {}).standard || []).map((w) => w.toLowerCase());
  // Standard list (pack + the sheet's own), then the sheet's industry and company lists and --negatives-extra. All broad match.
  const all = [...new Set([...pack, ...(p.sheetStandard || []), ...(p.extraNegatives || [])].map((w) => norm(w)).filter(Boolean))];
  const skip = new Set((c.standardSkip || []).map((w) => w.toLowerCase()));
  const ctx = { targets: [...p.keywords, ...(p.themes || []), ...(c.targets || [])], protect: c.protect || [] };
  const ok = [], skipped = [];
  for (const w of all) {
    if (skip.has(w)) continue;
    if (w.length > 80 || toks(w).length > 10) { skipped.push(`${w} (too long for a keyword)`); continue; }
    const why = guardNegative([w, 'BROAD'], ctx); if (why) skipped.push(`${w} (${why})`); else ok.push(w);
  }
  if (ok.length > 2000) skipped.push(`${ok.splice(2000).length} more (cap of 2000 negatives per campaign at creation)`);
  return { ok, skipped, fromSheet: (p.sheetStandard || []).length + (p.extraNegatives || []).length };
}

// ---------- live lookups (only when connected) ----------
const connected = () => !!secret('google')?.refresh_token && !!customerId();
async function resolveGeo(p) {
  const out = [];
  if (p.radius) {
    const place = { radius: p.radius, radiusUnits: 'MILES' };
    if (arg('lat') && arg('lng')) place.geoPoint = { latitudeInMicroDegrees: Math.round(+arg('lat') * 1e6), longitudeInMicroDegrees: Math.round(+arg('lng') * 1e6) };
    else { const g = p.geoLabel.trim(); place.address = /^\d{5}$/.test(g) ? { postalCode: g, countryCode: p.country } : { cityName: g.split(',')[0].trim(), provinceCode: (g.split(',')[1] || '').trim() || undefined, countryCode: p.country }; }
    out.push({ label: `${p.radius} miles around ${p.geoLabel || arg('lat') + ',' + arg('lng')}`, criterion: { proximity: place } });
    return out;
  }
  const names = list(p.geoLabel, ';');
  const j = await adsApi('geoTargetConstants:suggest', { locale: 'en', countryCode: p.country, locationNames: { names } });
  const sugg = j.geoTargetConstantSuggestions || [];
  for (const n of names) {
    // Prefer the real city (the setup targets the city itself), then any exact match, then a name match.
    const city = n.split(',')[0].trim().toLowerCase(), mine = sugg.filter((x) => (x.searchTerm || '').toLowerCase() === n.toLowerCase());
    const s = mine.find((x) => x.geoTargetConstant?.targetType === 'City' && x.geoTargetConstant.name?.toLowerCase() === city) || sugg.find((x) => x.geoTargetConstant?.targetType === 'City' && x.geoTargetConstant.name?.toLowerCase() === city)
      || mine[0] || sugg.find((x) => x.geoTargetConstant?.canonicalName?.toLowerCase().includes(city));
    if (!s) throw new Error(`could not find the place "${n}". Try "City, State, Country" or a ZIP with --radius`);
    out.push({ label: `${s.geoTargetConstant.canonicalName} (${s.geoTargetConstant.targetType})`, criterion: { location: { geoTargetConstant: s.geoTargetConstant.resourceName } } });
  }
  return out;
}
async function goalAndBidding(p) {
  const acts = await search(`SELECT conversion_action.resource_name, conversion_action.name, conversion_action.category, conversion_action.primary_for_goal, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);
  const g = GOALS[p.goal], named = (config().goalActions || {})[p.goal];
  const pickBy = (f) => acts.find((a) => f(a.conversionAction));
  const hit = (named && pickBy((a) => a.name.toLowerCase() === String(named).toLowerCase())) || pickBy((a) => g.prefer.test(a.name)) || pickBy((a) => g.re.test(a.name) && a.primaryForGoal) || pickBy((a) => g.re.test(a.name)) || pickBy((a) => g.cats.includes(a.category));
  const out = { action: hit ? { resourceName: hit.conversionAction.resourceName, name: hit.conversionAction.name, category: hit.conversionAction.category } : null, all: acts.map((a) => a.conversionAction.name) };
  let conv = 0, cost = 0;
  if (hit) {
    for (const x of await search(`SELECT segments.conversion_action, metrics.conversions FROM customer WHERE ${dateRange(30)}`)) if (x.segments.conversionAction === hit.conversionAction.resourceName) conv += Number(x.metrics.conversions || 0);
    for (const x of await search(`SELECT metrics.cost_micros FROM customer WHERE ${dateRange(30)}`)) cost += Number(x.metrics.costMicros || 0) / 1e6;
  }
  out.conv30 = conv; out.cost30 = cost;
  if (p.bidding === 'clicks') { out.bidding = biddingFor(p); out.biddingLabel = `Maximize Clicks, max $${p.maxCpc} a click (the setup for a new campaign; the goal "${hit?.conversionAction.name || p.goal}" is still tracked)${conv >= 30 ? `. This account already has ${conv.toFixed(0)} goal conversions in 30 days: Maximize Conversions may now do better, ask the owner` : ''}`; return out; }
  out.bidding = conv >= 30 ? { maximizeConversions: { targetCpaMicros: String(Math.round((cost / conv) * 1e6)) } } : { maximizeConversions: {} };
  out.biddingLabel = conv >= 30 ? `Target CPA $${(cost / conv).toFixed(2)} (the real 30-day average: ${conv.toFixed(0)} conversions)` : `Maximize Conversions (only ${conv.toFixed(0)} goal conversions in 30 days; switch to Target CPA after 30+ a month)`;
  return out;
}

// In-market and interest topics, matched by name (each asked name -> the best match). Observation only.
async function resolveAudiences(names) {
  const rows = await search(`SELECT user_interest.resource_name, user_interest.name, user_interest.taxonomy_type, user_interest.availabilities FROM user_interest WHERE user_interest.taxonomy_type IN ('IN_MARKET', 'AFFINITY')`);
  const out = [];
  for (const asked of names.slice(0, 10)) {
    const n = norm(asked), cand = rows.map((r) => r.userInterest).filter((u) => u?.name);
    const hit = cand.find((u) => norm(u.name) === n) || cand.find((u) => u.taxonomyType === 'IN_MARKET' && norm(u.name).includes(n)) || cand.find((u) => norm(u.name).includes(n));
    if (hit && !out.some((o) => o.resourceName === hit.resourceName)) out.push({ asked, name: `${hit.name} (${hit.taxonomyType === 'IN_MARKET' ? 'in-market' : 'interest'})`, resourceName: hit.resourceName });
  }
  return out;
}
// The --plan file shape (what the sheet becomes). Text is checked exactly like the sheet.
const PLAN_SHAPE = {
  niche: 'Plumber Denver',
  services: ['Drain cleaning', 'Water heater repair'],
  adGroups: [{ name: 'Emergency Plumber', exact: ['emergency plumber denver', 'plumber near me'], broad: ['24 hour emergency plumber in denver'], headlines: ['15 headlines, 30 characters each'], descriptions: ['4 descriptions, 90 characters each'] }],
  negatives: { standard: [], industry: ['course', 'salary'], company: ['competitor name'] },
  sitelinks: [{ text: 'Book a Free Estimate', url: 'https://example.com/denver/', description1: 'Same day service in Denver', description2: 'Licensed, local plumbers' }],
  callouts: ['Licensed & Insured', 'Same Day Service'],
  phone: '+1 303 555 0100',
  snippets: ['Drain Cleaning', 'Water Heater Repair', 'Leak Detection'],
};

// ---------- the API operations ----------
export function biddingFor(p) {
  if (p.bidding === 'clicks') return { targetSpend: { cpcBidCeilingMicros: String(Math.round(p.maxCpc * 1e6)) } };
  return { maximizeConversions: {} };
}
function buildOps(p, geo, gb) {
  const cid = customerId(), R = (k, id) => `customers/${cid}/${k}/${id}`;
  const B = R('campaignBudgets', -1), C = R('campaigns', -2), AG = R('assetGroups', -4);
  const ops = [];
  ops.push({ campaignBudgetOperation: { create: { resourceName: B, name: `${p.name} budget ${Date.now()}`, amountMicros: String(Math.round(p.budget * 1e6)), deliveryMethod: 'STANDARD', explicitlyShared: false } } });
  const camp = { resourceName: C, name: p.name, status: 'PAUSED', campaignBudget: B, ...(gb?.bidding || biddingFor(p)),
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
    startDateTime: `${p.start} 00:00:00`, ...(p.end ? { endDateTime: `${p.end} 23:59:59` } : {}),
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' };
  if (p.type === 'search') Object.assign(camp, { advertisingChannelType: 'SEARCH', networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    ...(p.audiencesResolved?.length ? { targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] } } : {}) });
  else Object.assign(camp, { advertisingChannelType: 'PERFORMANCE_MAX', brandGuidelinesEnabled: false });
  ops.push({ campaignOperation: { create: camp } });
  for (const g of geo) ops.push({ campaignCriterionOperation: { create: { campaign: C, ...g.criterion } } });
  ops.push({ campaignCriterionOperation: { create: { campaign: C, language: { languageConstant: `languageConstants/${p.language}` } } } });
  for (const s of p.schedule) ops.push({ campaignCriterionOperation: { create: { campaign: C, adSchedule: s } } });
  for (const w of p.negatives.ok) ops.push({ campaignCriterionOperation: { create: { campaign: C, negative: true, keyword: { text: w, matchType: 'BROAD' } } } });
  // Observation audiences: bidOnly above means they only collect data, they never narrow who sees the ad.
  if (p.type === 'search') for (const a of p.audiencesResolved || []) ops.push({ campaignCriterionOperation: { create: { campaign: C, userInterest: { userInterestCategory: a.resourceName } } } });
  // Campaign assets (sitelinks, callouts, structured snippet, call) make the ad bigger. Search and PMax both use them.
  let an = -1000;
  const asset = (body, fieldType) => { const r = R('assets', an--); ops.push({ assetOperation: { create: { resourceName: r, ...body } } }); ops.push({ campaignAssetOperation: { create: { campaign: C, asset: r, fieldType } } }); };
  for (const s of p.assets.sitelinks) asset({ finalUrls: [s.url || p.landing], sitelinkAsset: { linkText: s.text, description1: s.description1, description2: s.description2 } }, 'SITELINK');
  for (const t of p.assets.callouts) asset({ calloutAsset: { calloutText: t } }, 'CALLOUT');
  if (p.assets.snippets.length >= 3) asset({ structuredSnippetAsset: { header: p.assets.snippetHeader, values: p.assets.snippets } }, 'STRUCTURED_SNIPPET');
  if (p.assets.phone) asset({ callAsset: { countryCode: p.country, phoneNumber: p.assets.phone } }, 'CALL');
  if (p.type === 'search') {
    p.adGroups.forEach((g, i) => {
      const G = R('adGroups', -3 - i);
      ops.push({ adGroupOperation: { create: { resourceName: G, campaign: C, name: g.name, status: 'ENABLED', type: 'SEARCH_STANDARD', adRotationMode: 'OPTIMIZE' } } });
      for (const k of g.exact) ops.push({ adGroupCriterionOperation: { create: { adGroup: G, status: 'ENABLED', keyword: { text: k, matchType: 'EXACT' } } } });
      for (const k of g.broad) ops.push({ adGroupCriterionOperation: { create: { adGroup: G, status: 'ENABLED', keyword: { text: k, matchType: 'BROAD' } } } });
      ops.push({ adGroupAdOperation: { create: { adGroup: G, status: 'ENABLED', ad: { finalUrls: [p.landing], responsiveSearchAd: { headlines: g.headlines.map((text) => ({ text })), descriptions: g.descriptions.map((text) => ({ text })) } } } } });
    });
  } else {
    let n = -100; const links = [];
    const text = (t, fieldType) => { const r = R('assets', n--); ops.push({ assetOperation: { create: { resourceName: r, textAsset: { text: t } } } }); links.push({ asset: r, fieldType }); };
    p.headlines.forEach((t) => text(t, 'HEADLINE'));
    p.longHeadlines.forEach((t) => text(t, 'LONG_HEADLINE'));
    p.descriptions.forEach((t) => text(t, 'DESCRIPTION'));
    text(p.businessName, 'BUSINESS_NAME');
    for (const [fieldType, files] of Object.entries(p.images)) for (const f of files) {
      const r = R('assets', n--); ops.push({ assetOperation: { create: { resourceName: r, name: `${path.basename(f)} ${Date.now()}`, imageAsset: { data: fs.readFileSync(f).toString('base64') } } } }); links.push({ asset: r, fieldType });
    }
    ops.push({ assetGroupOperation: { create: { resourceName: AG, campaign: C, name: `${p.name} | asset group`, finalUrls: [p.landing], status: 'ENABLED' } } });
    for (const l of links) ops.push({ assetGroupAssetOperation: { create: { assetGroup: AG, ...l } } });
    for (const t of p.themes) ops.push({ assetGroupSignalOperation: { create: { assetGroup: AG, searchTheme: { text: t } } } });
  }
  return ops;
}
async function setGoal(campId, action, validateOnly = false) {
  const cid = customerId(), nm = `Primary goal: ${action.name}`.slice(0, 100);
  const have = await search(`SELECT custom_conversion_goal.resource_name, custom_conversion_goal.name FROM custom_conversion_goal WHERE custom_conversion_goal.status = 'ENABLED'`);
  let goal = have.find((x) => x.customConversionGoal.name === nm)?.customConversionGoal.resourceName;
  if (!goal) {
    const r = await adsApi(`customers/${cid}/customConversionGoals:mutate`, { operations: [{ create: { name: nm, conversionActions: [action.resourceName], status: 'ENABLED' } }], validateOnly });
    goal = r.results?.[0]?.resourceName; if (validateOnly) return 'validated';
  }
  await adsApi(`customers/${cid}/conversionGoalCampaignConfigs:mutate`, { operations: [{ update: { resourceName: `customers/${cid}/conversionGoalCampaignConfigs/${campId}`, goalConfigLevel: 'CAMPAIGN', customConversionGoal: goal }, updateMask: 'goal_config_level,custom_conversion_goal' }], validateOnly });
  return goal;
}

function printPlan(p, errors, warn, live) {
  const L = [];
  L.push(`CAMPAIGN PLAN: ${p.name}`);
  L.push(`  Type: ${p.type === 'pmax' ? 'Performance Max' : 'Search'}  |  starts PAUSED  |  budget $${p.budget}/day (about $${(p.budget * 30.4).toFixed(0)}/month)`);
  if (p.type === 'search') L.push('  Networks: Google Search only (no Display, no search partners)');
  L.push(`  Goal: ${p.goal}  ->  conversion action: ${live?.gb ? (live.gb.action ? live.gb.action.name : 'NONE FOUND (' + (live.gb.all.join(', ') || 'no actions') + ')') : 'checked when connected'}`);
  L.push(`  Bidding: ${live?.gb ? live.gb.biddingLabel : (p.bidding === 'clicks' ? `Maximize Clicks, max $${p.maxCpc} a click` : 'Maximize Conversions (Target CPA only after 30+ goal conversions a month)')}`);
  L.push(`  Budget rule: $${p.budget}/day at up to $${p.maxCpc} a click = at least ${Math.floor(p.budget / p.maxCpc)} clicks a day (the setup wants 5 to 10)`);
  L.push(`  Location: ${live?.geo ? live.geo.map((g) => g.label).join('; ') : (p.radius ? `${p.radius} miles around ${p.geoLabel}` : p.geoLabel)}  |  people IN the area (presence), not "interested in"`);
  L.push(`  Starts: ${p.start}${p.end ? `  |  ends ${p.end}` : '  |  no end date'}  |  schedule: ${p.schedule.length ? arg('schedule') : 'all day'}  |  language ${p.language}  |  ad rotation: optimize`);
  L.push(`  Landing page: ${p.landing}`);
  if (p.type === 'search') {
    L.push(`  Audiences (observation only): ${live?.aud ? (live.aud.map((a) => a.name).join(', ') || 'none found') : (p.audiences.join(', ') || 'none')}`);
    for (const g of p.adGroups) {
      L.push(`  AD GROUP "${g.name}": ${g.exact.length} exact [${g.exact.join('], [')}]${g.broad.length ? `  +  1 broad: ${g.broad[0]}` : ''}`);
      L.push(`    Headlines (${g.headlines.length}${g.drafted ? ', DRAFTED from settings, review them' : ''}):`); g.headlines.forEach((h) => L.push(`      [${String(h.length).padStart(2)}] ${h}`));
      L.push(`    Descriptions (${g.descriptions.length}):`); g.descriptions.forEach((d) => L.push(`      [${String(d.length).padStart(2)}] ${d}`));
    }
  } else {
    L.push(`  Search themes: ${p.themes.join(', ')}`); L.push(`  Business name: ${p.businessName}`); L.push(`  Long headlines: ${p.longHeadlines.map((h) => `"${h}"`).join(' | ')}`); L.push(`  Images: ${Object.entries(p.images).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    L.push(`  Headlines (${p.headlines.length}${p.drafted ? ', DRAFTED from settings, review them' : ''}):`); p.headlines.forEach((h) => L.push(`    [${String(h.length).padStart(2)}] ${h}`));
    L.push(`  Descriptions (${p.descriptions.length}):`); p.descriptions.forEach((d) => L.push(`    [${String(d.length).padStart(2)}] ${d}`));
  }
  const A = p.assets;
  L.push(`  Sitelinks (${A.sitelinks.length}): ${A.sitelinks.map((s) => `${s.text} -> ${s.url}`).join(' | ') || 'none'}`);
  L.push(`  Callouts (${A.callouts.length}): ${A.callouts.join(' | ') || 'none'}`);
  L.push(`  Structured snippet "${A.snippetHeader}" (${A.snippets.length}): ${A.snippets.join(' | ') || 'none'}`);
  L.push(`  Call: ${A.phone || 'none'}`);
  L.push(`  Negatives attached (broad): ${p.negatives.ok.length}${p.negatives.skipped.length ? `; skipped ${p.negatives.skipped.length} that would block a target: ${p.negatives.skipped.join(', ')}` : ''}`);
  if (warn.length) L.push('WARNINGS:', ...warn.map((w) => '  - ' + w));
  if (errors.length) L.push('MUST FIX BEFORE BUILDING:', ...errors.map((e) => '  - ' + e));
  console.log(L.join('\n'));
}

async function main() {
  if (cmd === 'template') {
    if (has('json')) { console.log(JSON.stringify(PLAN_SHAPE, null, 2)); return; }
    console.log(`Make the owner's own copy of the campaign template (never edit the master):\n  ${TEMPLATE_COPY_URL}\nFill the "${TABS.keywords}" and "${TABS.ads}" tabs for THIS business, then:\n  node pack.mjs campaign plan --sheet <link to the copy> --goal optin --landing https://... --geo "City, ST" --budget 50`);
    return;
  }
  if (!['plan', 'create'].includes(cmd)) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); if (cmd) process.exitCode = 2; return; }
  const { p, errors, warn } = await readInputs();
  const live = {};
  if (connected() && !errors.length) {
    try { live.geo = await resolveGeo(p); } catch (e) { errors.push('location: ' + explain(e)); }
    if (p.type === 'search' && p.audiences.length) { try { live.aud = p.audiencesResolved = await resolveAudiences(p.audiences); const miss = p.audiences.filter((n) => !live.aud.some((a) => a.asked === n)); if (miss.length) warn.push(`audience not found, skipped: ${miss.join(', ')}`); } catch (e) { warn.push('audiences skipped: ' + explain(e)); } }
    try { live.gb = await goalAndBidding(p); if (!live.gb.action && !has('no-goal')) errors.push(`no conversion action matches goal "${p.goal}". Set up tracking first (node pack.mjs tracking conversions), or name it: node pack.mjs set ... (config goalActions), or pass --no-goal (not advised)`); }
    catch (e) { errors.push('conversion goal: ' + explain(e)); }
  } else if (!connected()) warn.push('API check skipped: Google is not connected or no ad account is set (node pack.mjs doctor). Plan checked locally only.');
  printPlan(p, errors, warn, live);
  if (errors.length) process.exit(1);
  if (!connected()) { if (cmd === 'create') { console.error('Cannot create: not connected (node pack.mjs doctor).'); process.exit(3); } return; }
  const ops = buildOps(p, live.geo, live.gb);
  // Google checks the whole build first (validateOnly). Nothing is created by this step.
  try { await adsApi(`customers/${customerId()}/googleAds:mutate`, { mutateOperations: ops, validateOnly: true }); console.log(`\nGOOGLE CHECK: PASS (${ops.length} operations validated, nothing created).`); }
  catch (e) { console.error('\nGOOGLE CHECK FAILED, nothing created: ' + explain(e)); process.exit(1); }
  if (cmd === 'plan' || !has('confirm')) { console.log(`To build it PAUSED: node pack.mjs campaign create ${A.slice(1).map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'")).join(' ')} --confirm`); return; }
  const r = await adsApi(`customers/${customerId()}/googleAds:mutate`, { mutateOperations: ops });
  const campRn = (r.mutateOperationResponses || []).map((x) => x.campaignResult?.resourceName).find(Boolean);
  const campId = campRn?.split('/').pop();
  const rec = { at: new Date().toISOString(), plan: { ...p, images: p.images ? Object.fromEntries(Object.entries(p.images).map(([k, v]) => [k, v.map((f) => path.basename(f))])) : undefined }, campaign: campRn, operations: ops.length };
  if (live.gb?.action && campId) {
    try { rec.goal = await setGoal(campId, live.gb.action); console.log(`Conversion goal set: only "${live.gb.action.name}" counts for this campaign.`); }
    catch (e) { rec.goalError = explain(e); console.log(`WARNING: campaign built, but setting the campaign goal failed: ${explain(e)}\nSet it in Google Ads: campaign > Settings > Goals > use "${live.gb.action.name}" only.`); }
  }
  const [chk] = campId ? await search(`SELECT campaign.id, campaign.status, campaign.name FROM campaign WHERE campaign.id = ${Number(campId)}`) : [];
  writeJSON(path.join(DATA, 'campaigns', `${today()}-${campId || 'unknown'}.json`), rec);
  log('campaign', `created ${campRn} status=${chk?.campaign?.status} type=${p.type} budget=${p.budget}`);
  console.log(`Created PAUSED. Campaign ${campId} "${p.name}" (status now ${chk?.campaign?.status || 'unknown'}).\nTurn on with: node pack.mjs ads enable --campaign ${campId} --confirm (needs the owner's yes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { await main(); } catch (e) { console.error(explain(e)); process.exit(1); }
}
