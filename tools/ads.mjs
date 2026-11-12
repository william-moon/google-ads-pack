#!/usr/bin/env node
/*
 * ads.mjs: read + change Google Ads through the Google Ads API. Run it through: node pack.mjs ads <command> ...
 * Account = config.json adsCustomerId, or --account <id> on any command.
 *
 * READ
 *   accounts                                   ad accounts this Google login can reach
 *   campaigns     [--days 30]                  status, type, budget, clicks, conversions, cost, cost per conversion
 *   daily         [--days 14]                  totals per day
 *   keywords      [--days 30] [--limit 30]     keywords by cost
 *   search-terms  [--days 30] [--limit 30]     what people actually typed
 *   query "<GAQL>"                             any read query, raw JSON
 *   targets       [--campaign <id>]            what we target: PMax search themes + enabled keywords + config targets/protect
 *
 * CHANGE (every one is a dry run checked by Google with validateOnly, until you add --confirm)
 *   pause  --campaign <id> [--confirm]
 *   enable --campaign <id> [--confirm]                        SPEND CHANGE: needs the owner's yes
 *   budget --campaign <id> --daily <dollars> [--confirm]      SPEND CHANGE: needs the owner's yes
 *   negatives --campaign <id> --kw "word,[exact words]" [--confirm]   (broad or exact only, never phrase)    campaign level (Search + PMax)
 *   account-negatives --kw "..." [--confirm]                  account-level list: every Search/Shopping/PMax campaign, now and future
 *   exclude-placements --urls a.com,b.com [--confirm]         account level, every campaign
 *   exclude-ages --campaign <id> --ages 18_24,25_34 [--confirm]
 *   remove-assets --asset-group <id> --assets <assetId,...> [--confirm]   unlink from a PMax asset group
 *   neg-conflicts [--confirm]                                 find + remove any negative that blocks a target
 *
 * TARGET GUARD: negatives and account-negatives REFUSE any negative that would block a target or a protected (brand) word.
 * Pause, enable and budget change what the account spends: run them with --confirm only after the owner's plain yes.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { argv, arg, has, $, scrub } from '../lib/core.mjs';
import { adsApi, search, mutate, customerId, dateRange, blocks } from '../lib/ads.mjs';
import { targetsOf, forCampaign, guardKws, parseKwList } from '../lib/targets.mjs';

const A = argv[0] === 'ads' ? argv.slice(1) : argv;
const cmd = A[0];
const days = Number(arg('days', cmd === 'daily' ? 14 : 30)), limit = Number(arg('limit', 30));
const confirm = has('confirm');
const SPEND = "SPEND CHANGE: needs the owner's yes. Run again with --confirm only after they say yes.";
const cpa = (cost, conv) => (conv ? '$' + (Number(cost) / 1e6 / conv).toFixed(2) : '-');

export async function campaignOf(id) {
  if (!id || !/^\d+$/.test(String(id))) throw new Error('--campaign <numeric id> needed (see: node pack.mjs ads campaigns)');
  const r = await search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(id)}`);
  if (!r.length) throw new Error('no campaign ' + id + ' in account ' + customerId());
  return r[0];
}
const done = (r, n = 'added') => console.log(`DONE ${(r.results || []).filter((z) => z.resourceName).length} ${n}` + (r.partialFailureError ? ' | some failed: ' + r.partialFailureError.message : ''));
const dry = () => console.log('DRY RUN OK (Google checked it). Add --confirm to do it.');

async function main() {
  const cid = customerId();
  if (cmd === 'accounts') {
    const j = await adsApi('customers:listAccessibleCustomers');
    if (!(j.resourceNames || []).length) console.log('This Google login reaches no Google Ads accounts.');
    for (const rn of j.resourceNames || []) {
      const id = rn.split('/')[1];
      try { const [r] = await search('SELECT customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer', id);
        console.log(`${id}  ${r.customer.descriptiveName || '(no name)'}  ${r.customer.manager ? 'MANAGER' : 'ads account'}  ${r.customer.currencyCode} ${r.customer.timeZone}`); }
      catch (e) { console.log(`${id}  (details blocked: ${scrub(e.message).slice(0, 120)})`); }
    }
    console.log('\nPick one with: node pack.mjs set --ads <id>   (if it sits under a MANAGER account, also --manager <manager id>)');
  } else if (cmd === 'campaigns') {
    const r = await search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM campaign WHERE ${dateRange(days)} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC`);
    console.log(`Campaigns, last ${days} days (account ${cid}):`);
    if (!r.length) console.log('(none with data in this window)');
    for (const x of r) { const m = x.metrics, conv = Number(m.conversions || 0);
      console.log(`${x.campaign.id}  ${x.campaign.name}  [${x.campaign.status}, ${x.campaign.advertisingChannelType}, ${x.campaign.biddingStrategyType}]  budget $${$(x.campaignBudget?.amountMicros)}/day  clicks ${m.clicks || 0}  conv ${conv.toFixed(1)}  cost $${$(m.costMicros)}  cost/conv ${cpa(m.costMicros, conv)}`); }
  } else if (cmd === 'daily') {
    const r = await search(`SELECT segments.date, metrics.clicks, metrics.conversions, metrics.cost_micros FROM customer WHERE ${dateRange(days)} ORDER BY segments.date`);
    for (const x of r) console.log(`${x.segments.date}  clicks ${x.metrics.clicks || 0}  conv ${Number(x.metrics.conversions || 0).toFixed(1)}  cost $${$(x.metrics.costMicros)}`);
  } else if (cmd === 'keywords') {
    const r = await search(`SELECT campaign.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, metrics.clicks, metrics.conversions, metrics.cost_micros FROM keyword_view WHERE ${dateRange(days)} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`);
    for (const x of r) console.log(`${x.adGroupCriterion.keyword.text} (${x.adGroupCriterion.keyword.matchType}, ${x.adGroupCriterion.status})  ${x.campaign.name}  clicks ${x.metrics.clicks || 0}  conv ${Number(x.metrics.conversions || 0).toFixed(1)}  cost $${$(x.metrics.costMicros)}`);
  } else if (cmd === 'search-terms') {
    const r = await search(`SELECT search_term_view.search_term, campaign.name, metrics.clicks, metrics.conversions, metrics.cost_micros FROM search_term_view WHERE ${dateRange(days)} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`);
    for (const x of r) console.log(`"${x.searchTermView.searchTerm}"  ${x.campaign.name}  clicks ${x.metrics.clicks || 0}  conv ${Number(x.metrics.conversions || 0).toFixed(1)}  cost $${$(x.metrics.costMicros)}`);
    console.log('(Search campaigns only. Performance Max terms: node pack.mjs ads query "SELECT campaign_search_term_view.search_term, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign_search_term_view WHERE campaign.id = <id> AND segments.date DURING LAST_30_DAYS")');
  } else if (cmd === 'query') {
    if (!A[1]) throw new Error('usage: query "<GAQL>"');
    console.log(JSON.stringify(await search(A[1]), null, 1));
  } else if (cmd === 'targets') {
    console.log(JSON.stringify(await targetsOf(arg('campaign') || null), null, 1));
  } else if (cmd === 'pause' || cmd === 'enable') {
    const x = await campaignOf(arg('campaign')), status = cmd === 'pause' ? 'PAUSED' : 'ENABLED';
    console.log(`${cmd}: ${x.campaign.name} (${x.campaign.id}) ${x.campaign.status} -> ${status}`);
    const ops = [{ update: { resourceName: `customers/${cid}/campaigns/${x.campaign.id}`, status }, updateMask: 'status' }];
    if (!confirm) { await mutate('campaigns', ops, { validateOnly: true }); console.log(SPEND); dry(); return; }
    await mutate('campaigns', ops);
    console.log('DONE, now ' + (await campaignOf(x.campaign.id)).campaign.status);
  } else if (cmd === 'budget') {
    const x = await campaignOf(arg('campaign')), dollars = Number(arg('daily'));
    if (!(dollars > 0)) throw new Error('--daily <dollars> needed');
    const was = Number(x.campaignBudget.amountMicros) / 1e6;
    console.log(`budget: ${x.campaign.name} $${was.toFixed(2)}/day -> $${dollars.toFixed(2)}/day${x.campaignBudget.explicitlyShared ? ' (SHARED budget: changes every campaign using it)' : ''}`);
    if (was > 0 && dollars > was * 1.2) console.log(`Note: that is a ${Math.round((dollars / was - 1) * 100)}% raise. The safe pace is about 20% at a time.`);
    const ops = [{ update: { resourceName: x.campaignBudget.resourceName, amountMicros: String(Math.round(dollars * 1e6)) }, updateMask: 'amount_micros' }];
    if (!confirm) { await mutate('campaignBudgets', ops, { validateOnly: true }); console.log(SPEND); dry(); return; }
    await mutate('campaignBudgets', ops);
    console.log('DONE $' + $((await campaignOf(x.campaign.id)).campaignBudget.amountMicros) + '/day');
  } else if (cmd === 'negatives') {
    const x = await campaignOf(arg('campaign'));
    const { ok } = guardKws(parseKwList(arg('kw')), forCampaign(await targetsOf(x.campaign.id), x.campaign.id));
    if (!ok.length) { console.log('nothing to add'); return; }
    const ops = ok.map((k) => ({ create: { campaign: `customers/${cid}/campaigns/${x.campaign.id}`, negative: true, keyword: { text: k.replace(/^["\[]|["\]]$/g, '').trim(), matchType: k.startsWith('[') ? 'EXACT' : 'BROAD' } } }));
    console.log(`negatives on ${x.campaign.name}: ` + ops.map((o) => `${o.create.keyword.text} (${o.create.keyword.matchType})`).join(', '));
    const r = await adsApi(`customers/${cid}/campaignCriteria:mutate`, { operations: ops, partialFailure: true, validateOnly: !confirm });
    confirm ? done(r) : dry();
  } else if (cmd === 'account-negatives') {
    const { ok } = guardKws(parseKwList(arg('kw')), await targetsOf(null));
    const r = await accountNegatives(ok, { confirm });
    console.log(r.msg);
  } else if (cmd === 'exclude-placements') {
    const urls = String(arg('urls', '')).split(',').map((u) => u.trim()).filter(Boolean);
    if (!urls.length) throw new Error('--urls a.com,b.com needed');
    console.log('account-level placement exclusions: ' + urls.join(', '));
    const r = await adsApi(`customers/${cid}/customerNegativeCriteria:mutate`, { operations: urls.map((url) => ({ create: { placement: { url } } })), partialFailure: true, validateOnly: !confirm });
    confirm ? done(r) : dry();
  } else if (cmd === 'exclude-ages') {
    const x = await campaignOf(arg('campaign'));
    const ages = String(arg('ages', '')).split(',').map((a) => a.trim().toUpperCase()).filter(Boolean).map((a) => (a.startsWith('AGE_RANGE_') ? a : 'AGE_RANGE_' + a));
    if (!ages.length) throw new Error('--ages 18_24,25_34,... needed');
    console.log(`age exclusions on ${x.campaign.name}: ` + ages.join(', '));
    const r = await adsApi(`customers/${cid}/campaignCriteria:mutate`, { operations: ages.map((type) => ({ create: { campaign: `customers/${cid}/campaigns/${x.campaign.id}`, negative: true, ageRange: { type } } })), partialFailure: true, validateOnly: !confirm });
    confirm ? done(r) : dry();
  } else if (cmd === 'remove-assets') {
    const ag = arg('asset-group'), ids = String(arg('assets', '')).split(',').filter(Boolean);
    if (!/^\d+$/.test(String(ag)) || !ids.length) throw new Error('--asset-group <id> --assets <id,...> needed');
    const links = (await search(`SELECT asset_group_asset.resource_name, asset_group_asset.field_type, asset.id FROM asset_group_asset WHERE asset_group.id = ${Number(ag)}`)).filter((z) => ids.includes(String(z.asset.id)));
    if (!links.length) { console.log('none of those assets are linked to that asset group'); return; }
    console.log(`unlink from asset group ${ag}: ` + links.map((z) => `${z.asset.id} (${z.assetGroupAsset.fieldType})`).join(', '));
    const r = await mutate('assetGroupAssets', links.map((z) => ({ remove: z.assetGroupAsset.resourceName })), { validateOnly: !confirm });
    confirm ? console.log(`DONE ${(r.results || []).length} removed`) : dry();
  } else if (cmd === 'neg-conflicts') {
    await negConflicts({ confirm });
  } else {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, ''));
    if (cmd) process.exitCode = 2;
  }
}

// Account-level negative keyword list (one per account, max 1,000 words). Creates it and attaches it if missing.
export async function accountNegatives(kws, { confirm = false } = {}) {
  const cid = customerId();
  const op = (ss, k) => ({ sharedCriterionOperation: { create: { sharedSet: ss, keyword: { text: k.replace(/^["\[]|["\]]$/g, '').trim(), matchType: k.startsWith('[') ? 'EXACT' : 'BROAD' } } } });
  const key = (o) => o.sharedCriterionOperation.create.keyword.text.toLowerCase() + '|' + o.sharedCriterionOperation.create.keyword.matchType;
  const cur = await search(`SELECT shared_set.resource_name, shared_set.name, shared_set.member_count FROM shared_set WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
  let ops, head;
  if (cur.length) {
    const ss = cur[0].sharedSet.resourceName;
    const have = new Set((await search(`SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.resource_name = '${ss}'`)).map((x) => x.sharedCriterion.keyword.text.toLowerCase() + '|' + x.sharedCriterion.keyword.matchType));
    ops = kws.map((k) => op(ss, k)).filter((o) => !have.has(key(o)));
    head = `account-level list exists (${have.size} words); adding ${ops.length} new`;
  } else {
    const ss = `customers/${cid}/sharedSets/-1`;
    ops = kws.length ? [{ sharedSetOperation: { create: { resourceName: ss, name: 'Account-level negative keywords', type: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' } } }, ...kws.map((k) => op(ss, k)), { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: ss } } } }] : [];
    head = `creating the account-level negative list with ${kws.length} words`;
  }
  const added = ops.filter((o) => o.sharedCriterionOperation).map((o) => o.sharedCriterionOperation.create.keyword.text);
  if (!added.length) return { added: [], msg: head + '\nnothing to add' };
  const r = await adsApi(`customers/${cid}/googleAds:mutate`, { mutateOperations: ops, validateOnly: !confirm });
  return { added, msg: head + '\n' + (confirm ? `DONE ${(r.mutateOperationResponses || []).length} operations` : 'DRY RUN OK (Google checked it). Add --confirm to do it.') };
}

// Removes every negative that blocks a target. An account-level word removed this way is re-added at campaign
// level on the other Search/PMax/Shopping campaigns whose targets it does not block, so they keep their coverage.
export async function negConflicts({ confirm = false } = {}) {
  const cid = customerId(), T = await targetsOf(null);
  const camp = await search(`SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED'`);
  const shared = await search(`SELECT shared_criterion.resource_name, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED' AND shared_criterion.type = 'KEYWORD'`);
  const campRm = [], shRm = [], hits = [];
  const show = (t, m) => (m === 'PHRASE' ? `"${t}"` : m === 'EXACT' ? `[${t}]` : t);
  for (const x of camp) { const k = x.campaignCriterion.keyword, b = forCampaign(T, x.campaign.id).filter((t) => blocks(k.text, k.matchType, t.t)); if (b.length) { campRm.push(x.campaignCriterion.resourceName); hits.push(`campaign ${x.campaign.id}: ${show(k.text, k.matchType)} blocks ${[...new Set(b.map((t) => t.t))].join(' | ')}`); } }
  for (const x of shared) { const k = x.sharedCriterion.keyword, b = T.filter((t) => blocks(k.text, k.matchType, t.t)); if (b.length) { shRm.push(x); hits.push(`account: ${show(k.text, k.matchType)} blocks ${[...new Set(b.map((t) => t.t))].join(' | ')}`); } }
  hits.forEach((h) => console.log(h));
  if (!hits.length) { console.log('no conflicts: no negative blocks a target'); return { removed: 0 }; }
  const kwCamps = (await search(`SELECT campaign.id FROM campaign WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type IN ('SEARCH','PERFORMANCE_MAX','SHOPPING')`)).map((x) => String(x.campaign.id));
  const have = new Set(camp.map((x) => x.campaign.id + '|' + x.campaignCriterion.keyword.text.toLowerCase() + '|' + x.campaignCriterion.keyword.matchType));
  const rehome = [];
  for (const x of shRm) { const k = x.sharedCriterion.keyword; for (const c of kwCamps) if (!forCampaign(T, c).some((t) => blocks(k.text, k.matchType, t.t)) && !have.has(c + '|' + k.text.toLowerCase() + '|' + k.matchType)) rehome.push({ create: { campaign: `customers/${cid}/campaigns/${c}`, negative: true, keyword: { text: k.text, matchType: k.matchType } } }); }
  console.log(`plan: remove ${campRm.length} campaign-level + ${shRm.length} account-level negatives; re-add ${rehome.length} campaign-level ones where they do not conflict`);
  const v = !confirm;
  if (campRm.length) await mutate('campaignCriteria', campRm.map((r) => ({ remove: r })), { validateOnly: v });
  if (shRm.length) await mutate('sharedCriteria', shRm.map((x) => ({ remove: x.sharedCriterion.resourceName })), { validateOnly: v });
  if (rehome.length) await adsApi(`customers/${cid}/campaignCriteria:mutate`, { operations: rehome, partialFailure: true, validateOnly: v });
  console.log(v ? 'DRY RUN OK (Google checked it). Add --confirm to do it.' : 'DONE');
  return { removed: campRm.length + shRm.length };
}

export function explain(e) {
  const m = scrub(String(e?.message || e));
  if (/only approved for use with test accounts|apply for (Explorer|Basic)/i.test(m)) return 'ACCESS LEVEL: your Google Cloud project only has test access to the Google Ads API. Apply for Explorer/Basic access on the Google Ads API page of your Cloud console. ' + m;
  if (/DEVELOPER_TOKEN/i.test(m)) return 'DEVELOPER TOKEN: Google asked for a developer token. Put it in secrets/google.json as "developer_token". ' + m;
  if (/USER_PERMISSION_DENIED/i.test(m)) return 'NO ACCESS: this Google login cannot open that ad account. If it is under a manager account: node pack.mjs set --manager <manager id>. ' + m;
  return 'ERROR ' + m;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main(); } catch (e) { console.error(explain(e)); process.exit(1); }
}
