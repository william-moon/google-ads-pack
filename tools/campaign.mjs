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
 * Rules built in: Search network only (no Display, no search partners). Presence targeting (people IN the area).
 * Maximize Conversions while the goal has under 30 conversions a month, then Target CPA near the real average.
 * Phrase + exact match on buyer keywords only (informational keywords are refused). Standard negatives attached.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACK, DATA, argv, arg, has, config, secret, readJSON, writeJSON, log, today } from '../lib/core.mjs';
import { adsApi, search, customerId, dateRange } from '../lib/ads.mjs';
import { classifyTerm, guardNegative, norm, toks } from '../lib/classify.mjs';
import { explain } from './ads.mjs';

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

// ---------- build the plan ----------
function readInputs() {
  const c = config();
  const goal = arg('goal'), type = arg('type', 'search'), budget = Number(arg('budget')), landing = arg('landing', '');
  const errors = [], warn = [];
  if (!GOALS[goal]) errors.push('--goal must be booked, optin or sales');
  if (!['search', 'pmax'].includes(type)) errors.push('--type must be search or pmax');
  if (!(budget > 0)) errors.push('--budget <daily dollars> needed');
  else if (budget < 5) warn.push(`$${budget}/day is very low: the campaign may get almost no clicks`);
  if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(landing)) errors.push('--landing must be a full https:// address of the page where people book, opt in or buy');
  if (!arg('geo') && !(arg('lat') && arg('lng'))) errors.push('--geo "<city, state>" (or a ZIP with --radius) needed: never run ads to the whole country by accident');
  const kw = checkKeywords(list(arg('keywords')), c);
  if (!kw.ok.length) errors.push('--keywords needed: buyer keywords only (for example "emergency plumber denver")');
  kw.refused.forEach((r) => errors.push('keyword refused, informational or not a buyer search: ' + r)); warn.push(...kw.warn);
  const name = arg('name') || `${c.businessName || 'Campaign'} | ${type === 'pmax' ? 'PMax' : 'Search'} | ${goal || ''} | ${today()}`;
  const geoLabel = arg('geo', '');
  const draft = draftCopy(c, kw.ok, geoLabel, goal);
  const headlines = arg('headlines') ? list(arg('headlines'), '|') : draft.headlines;
  const descriptions = arg('descriptions') ? list(arg('descriptions'), '|') : draft.descriptions;
  const drafted = !arg('headlines') || !arg('descriptions');
  let schedule = []; try { schedule = parseSchedule(arg('schedule')); } catch (e) { errors.push(e.message); }
  const p = { name, goal, type, budget, landing, geoLabel, radius: arg('radius') ? Number(arg('radius')) : null, keywords: kw.ok, headlines, descriptions, drafted, schedule,
    country: arg('country', 'US'), language: arg('language', '1000') };
  if (type === 'search') errors.push(...checkRsa(headlines, descriptions));
  else {
    p.longHeadlines = arg('long-headlines') ? list(arg('long-headlines'), '|') : [descriptions[0]].filter((d) => d && d.length <= 90);
    p.businessName = arg('business-name', c.businessName || '');
    p.themes = arg('themes') ? list(arg('themes')).map(norm) : kw.ok.slice(0, 25);
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
  const std = (readJSON(path.join(PACK, 'data', 'standard-negatives.json'), {}).standard || []).map((w) => w.toLowerCase());
  const skip = new Set((c.standardSkip || []).map((w) => w.toLowerCase()));
  const ctx = { targets: [...p.keywords, ...(p.themes || []), ...(c.targets || [])], protect: c.protect || [] };
  const ok = [], skipped = [];
  for (const w of std) { if (skip.has(w)) continue; const why = guardNegative([w, 'BROAD'], ctx); if (why) skipped.push(`${w} (${why})`); else ok.push(w); }
  return { ok, skipped };
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
    const s = sugg.find((x) => (x.searchTerm || '').toLowerCase() === n.toLowerCase()) || sugg.find((x) => x.geoTargetConstant?.canonicalName?.toLowerCase().includes(n.split(',')[0].trim().toLowerCase()));
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
  out.bidding = conv >= 30 ? { maximizeConversions: { targetCpaMicros: String(Math.round((cost / conv) * 1e6)) } } : { maximizeConversions: {} };
  out.biddingLabel = conv >= 30 ? `Target CPA $${(cost / conv).toFixed(2)} (the real 30-day average: ${conv.toFixed(0)} conversions)` : `Maximize Conversions (only ${conv.toFixed(0)} goal conversions in 30 days; switch to Target CPA after 30+ a month)`;
  return out;
}

// ---------- the API operations ----------
function buildOps(p, geo, gb) {
  const cid = customerId(), R = (k, id) => `customers/${cid}/${k}/${id}`;
  const B = R('campaignBudgets', -1), C = R('campaigns', -2), G = R('adGroups', -3), AG = R('assetGroups', -4);
  const ops = [];
  ops.push({ campaignBudgetOperation: { create: { resourceName: B, name: `${p.name} budget ${Date.now()}`, amountMicros: String(Math.round(p.budget * 1e6)), deliveryMethod: 'STANDARD', explicitlyShared: false } } });
  const camp = { resourceName: C, name: p.name, status: 'PAUSED', campaignBudget: B, ...(gb?.bidding || { maximizeConversions: {} }),
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' };
  if (p.type === 'search') Object.assign(camp, { advertisingChannelType: 'SEARCH', networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false } });
  else Object.assign(camp, { advertisingChannelType: 'PERFORMANCE_MAX', brandGuidelinesEnabled: false });
  ops.push({ campaignOperation: { create: camp } });
  for (const g of geo) ops.push({ campaignCriterionOperation: { create: { campaign: C, ...g.criterion } } });
  ops.push({ campaignCriterionOperation: { create: { campaign: C, language: { languageConstant: `languageConstants/${p.language}` } } } });
  for (const s of p.schedule) ops.push({ campaignCriterionOperation: { create: { campaign: C, adSchedule: s } } });
  for (const w of p.negatives.ok) ops.push({ campaignCriterionOperation: { create: { campaign: C, negative: true, keyword: { text: w, matchType: 'BROAD' } } } });
  if (p.type === 'search') {
    ops.push({ adGroupOperation: { create: { resourceName: G, campaign: C, name: `${p.name} | ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD' } } });
    for (const k of p.keywords) for (const matchType of ['PHRASE', 'EXACT']) ops.push({ adGroupCriterionOperation: { create: { adGroup: G, status: 'ENABLED', keyword: { text: k, matchType } } } });
    ops.push({ adGroupAdOperation: { create: { adGroup: G, status: 'ENABLED', ad: { finalUrls: [p.landing], responsiveSearchAd: { headlines: p.headlines.map((text) => ({ text })), descriptions: p.descriptions.map((text) => ({ text })) } } } } });
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
  L.push(`  Bidding: ${live?.gb ? live.gb.biddingLabel : 'Maximize Conversions (Target CPA only after 30+ goal conversions a month)'}`);
  L.push(`  Location: ${live?.geo ? live.geo.map((g) => g.label).join('; ') : (p.radius ? `${p.radius} miles around ${p.geoLabel}` : p.geoLabel)}  |  people IN the area (presence), not "interested in"`);
  L.push(`  Schedule: ${p.schedule.length ? arg('schedule') : 'all hours'}  |  language ${p.language}`);
  L.push(`  Landing page: ${p.landing}`);
  if (p.type === 'search') L.push(`  Keywords (phrase + exact): ${p.keywords.join(', ')}`);
  else { L.push(`  Search themes: ${p.themes.join(', ')}`); L.push(`  Business name: ${p.businessName}`); L.push(`  Long headlines: ${p.longHeadlines.map((h) => `"${h}"`).join(' | ')}`); L.push(`  Images: ${Object.entries(p.images).map(([k, v]) => `${k} ${v.length}`).join(', ')}`); }
  L.push(`  Headlines (${p.headlines.length}${p.drafted ? ', DRAFTED from settings, review them' : ''}):`); p.headlines.forEach((h) => L.push(`    [${String(h.length).padStart(2)}] ${h}`));
  L.push(`  Descriptions (${p.descriptions.length}):`); p.descriptions.forEach((d) => L.push(`    [${String(d.length).padStart(2)}] ${d}`));
  L.push(`  Standard negatives attached: ${p.negatives.ok.length}${p.negatives.skipped.length ? `; skipped ${p.negatives.skipped.length} that would block a target: ${p.negatives.skipped.join(', ')}` : ''}`);
  if (warn.length) L.push('WARNINGS:', ...warn.map((w) => '  - ' + w));
  if (errors.length) L.push('MUST FIX BEFORE BUILDING:', ...errors.map((e) => '  - ' + e));
  console.log(L.join('\n'));
}

async function main() {
  if (!['plan', 'create'].includes(cmd)) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); if (cmd) process.exitCode = 2; return; }
  const { p, errors, warn } = readInputs();
  const live = {};
  if (connected() && !errors.length) {
    try { live.geo = await resolveGeo(p); } catch (e) { errors.push('location: ' + explain(e)); }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (e) { console.error(explain(e)); process.exit(1); }
}
