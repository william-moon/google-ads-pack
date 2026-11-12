// plan-sheet.mjs: read the owner's copy of the "Google Ad Template" spreadsheet into a campaign plan.
// Make a copy first (never edit the master): https://docs.google.com/spreadsheets/d/1GaV9Yc1wSWyqHQe2Zr-JWtwPT4Rg2ttokxIlgAs9XWM/copy
// Two tabs are read by name: "KWs Template" (keywords + negatives) and "Google Ads Template" (ad copy + assets).
// Everything read here is the owner's text: it is checked by campaign.mjs (lengths, buyer intent, policy) before use.

export const TEMPLATE_COPY_URL = 'https://docs.google.com/spreadsheets/d/1GaV9Yc1wSWyqHQe2Zr-JWtwPT4Rg2ttokxIlgAs9XWM/copy';
export const TABS = { keywords: 'KWs Template', ads: 'Google Ads Template' };
const PLACEHOLDER = /^(your (url|#|number|phone)( here)?|url|description.*|n\/?a|tbd|-+)$/i;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Small RFC 4180 CSV reader (quotes, "" escapes, newlines inside quotes).
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The header row is the first row that names a known column.
function headerRow(rows, re) { const i = rows.findIndex((r) => r.some((c) => re.test(clean(c)))); return i < 0 ? -1 : i; }
// Values down one column under the header. stopAtBlank: lists that end at the first empty cell (keywords, services).
function column(rows, from, col, stopAtBlank) {
  const out = [];
  for (let r = from; r < rows.length; r++) { const v = clean(rows[r][col]); if (!v) { if (stopAtBlank && out.length) break; continue; } out.push(v); }
  return out;
}

export function parseKeywordsTab(rows) {
  const h = headerRow(rows, /exact match keywords|list of services/i);
  if (h < 0) throw new Error(`the "${TABS.keywords}" tab has no "Exact Match Keywords" header`);
  const head = rows[h].map(clean);
  const out = { niche: '', services: [], groups: {}, negatives: { standard: [], industry: [], company: [] } };
  let neg = null; // negative-list headers span several columns: carry them to the right
  head.forEach((t, c) => {
    let m;
    if (/standard negative/i.test(t)) neg = 'standard';
    else if (/(industry|niche specific).*(negative|keyword)|^industry keywords/i.test(t)) neg = 'industry';
    else if (/company negative|competitor/i.test(t)) neg = 'company';
    else if (t) neg = null;
    if ((m = /exact match keywords ad group #?\s*(\d+)/i.exec(t))) (out.groups[m[1]] ||= { exact: [], broad: [] }).exact.push(...column(rows, h + 1, c, true));
    else if ((m = /broad (match )?keywords ad group #?\s*(\d+)/i.exec(t))) (out.groups[m[2]] ||= { exact: [], broad: [] }).broad.push(...column(rows, h + 1, c, true));
    else if (/list of services/i.test(t)) out.services = column(rows, h + 1, c, true);
    else if (/^niche:?$/i.test(t)) out.niche = column(rows, h + 1, c, true)[0] || '';
    else if (neg) out.negatives[neg].push(...column(rows, h + 1, c, false));
  });
  // The group label sits in the header cell under the title ("Exact Match Keywords Ad Group #1:\n401k Rollover Help").
  head.forEach((t) => { const m = /exact match keywords ad group #?\s*(\d+):?\s*(.*)$/i.exec(t); if (m && m[2] && out.groups[m[1]]) out.groups[m[1]].label = clean(m[2]); });
  for (const k of Object.keys(out.negatives)) out.negatives[k] = [...new Set(out.negatives[k].map((w) => w.toLowerCase()))];
  out.niche = clean(out.niche.replace(/[()]/g, ' '));
  return out;
}

export function parseAdsTab(rows) {
  const h = headerRow(rows, /ad headlines|descriptions/i);
  if (h < 0) throw new Error(`the "${TABS.ads}" tab has no "Ad Headlines" header`);
  const head = rows[h].map(clean);
  const col = (re) => head.findIndex((t) => re.test(t));
  const cName = col(/ad group name/i), cH = col(/headlines/i), cD = col(/descriptions/i), cCall = col(/call ?out/i), cPhone = col(/^calls?$/i), cSnip = col(/structured snippet/i);
  const cSite = head.map((t, i) => (/sitelinks?/i.test(t) ? i : -1)).filter((i) => i >= 0);
  // Ad group blocks: each row with a name in "Ad Group Name" starts a block (one block when the column is empty).
  const starts = [];
  for (let r = h + 1; r < rows.length; r++) if (cName >= 0 && clean(rows[r][cName])) starts.push(r);
  if (!starts.length) starts.push(h + 1);
  const groups = starts.map((s, i) => {
    const end = starts[i + 1] ?? rows.length, sub = rows.slice(s, end);
    return { name: cName >= 0 ? clean(rows[s][cName]) : '', headlines: column(sub, 0, cH, false), descriptions: cD >= 0 ? column(sub, 0, cD, false) : [] };
  });
  const sitelinks = cSite.map((c) => {
    const v = column(rows, h + 1, c, false); const text = v[0] || '';
    const url = v.find((x) => /^https?:\/\//i.test(x)) || '';
    const di = v.findIndex((x) => /^description/i.test(x));
    const desc = (di >= 0 ? v.slice(di + 1) : v.slice(1).filter((x) => !/^https?:\/\//i.test(x) && !PLACEHOLDER.test(x))).filter((x) => !PLACEHOLDER.test(x));
    return text && !PLACEHOLDER.test(text) ? { text, url, description1: desc[0] || '', description2: desc[1] || '' } : null;
  }).filter(Boolean);
  const callouts = cCall >= 0 ? column(rows, h + 1, cCall, false).filter((x) => !PLACEHOLDER.test(x)) : [];
  const phone = cPhone >= 0 ? (column(rows, h + 1, cPhone, false).find((x) => !PLACEHOLDER.test(x) && /\d{7,}/.test(x.replace(/\D/g, ''))) || '') : '';
  let snippetHeader = 'Service catalog', snippets = [];
  if (cSnip >= 0) { const v = column(rows, h + 1, cSnip, false); if (v[0] && /catalog|services|types|brands|amenities|styles|models|courses|destinations|neighborhoods|shows|insurance coverage|degree programs|featured hotels/i.test(v[0]) && v[0].length <= 25 && !/\d/.test(v[0])) { snippetHeader = /service catalog/i.test(v[0]) ? 'Service catalog' : v[0]; snippets = v.slice(1); } else snippets = v; }
  return { groups, sitelinks, callouts, phone, snippetHeader, snippets: snippets.filter((x) => !PLACEHOLDER.test(x)) };
}

// Merge the two tabs into one plan. Keyword group N uses ad block N (or the first block when there is only one).
export function planFromTabs(kwRows, adRows) {
  const k = parseKeywordsTab(kwRows), a = parseAdsTab(adRows);
  const ids = Object.keys(k.groups).sort((x, y) => x - y).filter((id) => k.groups[id].exact.length || k.groups[id].broad.length);
  if (!ids.length) throw new Error('no keywords found under "Exact Match Keywords Ad Group #1"');
  const adGroups = ids.map((id, i) => {
    const ad = a.groups[i] || a.groups[0];
    return { name: ad.name || k.groups[id].label || `Ad Group ${id}`, exact: k.groups[id].exact, broad: k.groups[id].broad, headlines: ad.headlines, descriptions: ad.descriptions };
  });
  return { niche: k.niche, services: k.services, adGroups, negatives: k.negatives, sitelinks: a.sitelinks, callouts: a.callouts, phone: a.phone, snippetHeader: a.snippetHeader, snippets: a.snippets };
}

export function sheetId(s) { const m = /\/d\/([\w-]{20,})/.exec(String(s)) || /^([\w-]{20,})$/.exec(String(s).trim()); if (!m) throw new Error('--sheet needs the Google Sheets link (or its id) of YOUR copy of the template'); return m[1]; }
export const tabCsvUrl = (id, tab) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
