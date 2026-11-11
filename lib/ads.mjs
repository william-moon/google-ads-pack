// ads.mjs: Google Ads API helpers (REST). Account id comes from config.json (adsCustomerId) or --account.
// Google retired developer tokens on Sep 9 2026: access is set per Cloud project (Google Ads API page in the
// owner's Cloud console). If the owner's project still needs one, put it in secrets/google.json as developer_token.
import { gapi } from './google.mjs';
import { config, secret, arg } from './core.mjs';

export const V = process.env.GADS_API_VERSION || 'v24';
export const customerId = () => String(arg('account') || config().adsCustomerId || '').replace(/-/g, '');
const extra = () => {
  const g = secret('google') || {}, c = config(), h = {};
  if (g.developer_token) h['developer-token'] = g.developer_token;
  if (c.adsLoginCustomerId) h['login-customer-id'] = String(c.adsLoginCustomerId).replace(/-/g, '');
  return h;
};
export const adsApi = (p, body) => gapi(`https://googleads.googleapis.com/${V}/${p}`, { method: body ? 'POST' : 'GET', body, headers: extra() });
export async function search(q, cid = customerId()) {
  if (!cid) throw new Error('no Google Ads account set. Run: node pack.mjs ads accounts, then node pack.mjs set --ads <id>');
  const out = []; let pageToken;
  do { const j = await adsApi(`customers/${cid}/googleAds:search`, { query: q, ...(pageToken ? { pageToken } : {}) }); out.push(...(j.results || [])); pageToken = j.nextPageToken; } while (pageToken);
  return out;
}
export const mutate = (resource, operations, { validateOnly = false, cid = customerId() } = {}) =>
  adsApi(`customers/${cid}/${resource}:mutate`, { operations, validateOnly, partialFailure: false });
export function dateRange(days) {
  const e = new Date(), s = new Date(e - (days - 1) * 864e5), f = (d) => d.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${f(s)}' AND '${f(e)}'`;
}
// negatives: plain = BROAD, "quoted" = PHRASE, [bracketed] = EXACT
export const kwMatch = (k) => (k.startsWith('"') ? 'PHRASE' : k.startsWith('[') ? 'EXACT' : 'BROAD');
export const kwText = (k) => k.replace(/^["\[]|["\]]$/g, '').trim();
const toks = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}'&$.]+/gu) || [];
export function blocks(neg, match, term) {
  const n = toks(neg), s = toks(term); if (!n.length) return false;
  if (match === 'EXACT') return n.join(' ') === s.join(' ');
  if (match === 'PHRASE') return (' ' + s.join(' ') + ' ').includes(' ' + n.join(' ') + ' ');
  return n.every((w) => s.includes(w));
}
