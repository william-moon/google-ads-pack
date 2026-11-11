// targets.mjs: the TARGET GUARD. A negative keyword may never block something we target.
// Targets = Performance Max search themes (non-removed campaigns) + enabled keywords in enabled Search
// campaigns + config.json "targets" + config.json "protect" (brand words). Negatives adapt to targets, never the reverse.
import { search, blocks, kwMatch, kwText } from './ads.mjs';
import { config } from './core.mjs';

export async function targetsOf(campId = null) {
  const w = campId ? ` AND campaign.id = ${Number(campId)}` : '';
  const out = [];
  for (const x of await search(`SELECT campaign.id, asset_group_signal.search_theme.text FROM asset_group_signal WHERE campaign.status != 'REMOVED' AND asset_group.status != 'REMOVED'${w}`))
    if (x.assetGroupSignal?.searchTheme?.text) out.push({ campaign: String(x.campaign.id), t: x.assetGroupSignal.searchTheme.text.toLowerCase(), src: 'search theme' });
  for (const x of await search(`SELECT campaign.id, ad_group_criterion.keyword.text FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'${w}`))
    out.push({ campaign: String(x.campaign.id), t: x.adGroupCriterion.keyword.text.toLowerCase(), src: 'keyword' });
  out.push(...configTargets());
  return out;
}
// "*" = applies to every campaign in the account.
export function configTargets() {
  const c = config(), out = [];
  for (const t of c.targets || []) out.push({ campaign: '*', t: String(t).toLowerCase(), src: 'config target' });
  for (const t of c.protect || []) out.push({ campaign: '*', t: String(t).toLowerCase(), src: 'protected word' });
  return out;
}
export const forCampaign = (T, cid) => T.filter((x) => x.campaign === '*' || x.campaign === String(cid));
export const hitOf = (T, k) => T.find((x) => blocks(kwText(k), kwMatch(k), x.t));

// Split a --kw list: plain = broad, "quoted" = phrase, [bracketed] = exact.
export const parseKwList = (s) => (String(s || '').match(/"[^"]+"|\[[^\]]+\]|[^,]+/g) || []).map((k) => k.trim()).filter((k) => k && k !== ',');

// Drops any negative that would block a target and says why. T = targetsOf() result (already scoped).
export function guardKws(kws, T, say = console.log) {
  const ok = [], refused = [];
  for (const k of kws) { const hit = hitOf(T, k); if (hit) { refused.push({ k, hit }); say(`REFUSED ${k}: would block ${hit.src} "${hit.t}"${hit.campaign !== '*' ? ` (campaign ${hit.campaign})` : ''}`); } else ok.push(k); }
  return { ok, refused };
}
