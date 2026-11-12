---
name: google-ads
description: >
  Analyze, fix and build Google Ads with real data, and turn it into clear Keep / Fix / Stop decisions.
  Use automatically whenever anyone mentions Google Ads, PPC, ad spend, cost per lead, campaigns,
  Performance Max, search terms, negative keywords, placements, Quality Score, or asks to build a
  campaign, review, audit, report on or improve ads. Read-only by default. Every change is a dry run
  until the owner says yes, and money moves always need the owner's yes.
---

# Google Ads skill (any business)

Goal: find where every dollar goes, what really brings the result the business wants (booked calls,
opt-ins, sales), and make a short list of decisions backed by numbers. Never guess. Every number in a
report comes from the account itself or a named outside tool.

---

## 0. The commands (run from the pack folder)

    node pack.mjs doctor                                   # what is set up, what is missing
    node pack.mjs ads accounts                             # every ad account this Google login reaches
    node pack.mjs set --ads <id> [--manager <id>]          # pick the account (manager id only if it sits under one)
    node pack.mjs ads campaigns    [--days 30]
    node pack.mjs ads daily        [--days 14]
    node pack.mjs ads keywords     [--days 30] [--limit 30]
    node pack.mjs ads search-terms [--days 30] [--limit 30]
    node pack.mjs ads query "<GAQL from section 3>"        # any read, raw JSON
    node pack.mjs ads targets [--campaign <id>]            # what we target (themes, keywords, config targets, brand words)
    node pack.mjs report weekly                            # the Keep / Fix / Stop report (section 7), saved to data/reports/

Changes. Each one is a dry run that Google checks (validateOnly) until you add --confirm:

    node pack.mjs ads negatives --campaign <id> --kw "word,\"a phrase\",[exact words]"
    node pack.mjs ads account-negatives --kw "..."          # account-level list: every Search, Shopping and PMax campaign
    node pack.mjs ads exclude-placements --urls a.com,b.com # whole account
    node pack.mjs ads exclude-ages --campaign <id> --ages 18_24,25_34
    node pack.mjs ads remove-assets --asset-group <id> --assets <id,...>
    node pack.mjs ads neg-conflicts                         # remove any negative that blocks a target
    node pack.mjs ads pause  --campaign <id>
    node pack.mjs ads enable --campaign <id>                # SPEND CHANGE: owner's yes first
    node pack.mjs ads budget --campaign <id> --daily <dollars>   # SPEND CHANGE: owner's yes first
    node pack.mjs negatives standard | sweep | apply | conflicts  # see skills/negative-keywords/SKILL.md
    node pack.mjs campaign plan | create                    # the campaign builder (section 9)

Settings live in $GADS_HOME/config.json (default ~/.google-ads-pack). Useful keys: businessName, domain,
business (one line on what they sell), services, targets, protect (brand words), competitors, offNiche,
negativesMode (auto or propose), goalActions (for example {"booked":"Booked Call"}), targetCpa (dollars),
standardSkip (standard negatives this business must not use).

Rules:
1. Work only on the owner's own ad account.
2. Enable, budget and bidding changes cost money: the owner's plain "yes" first, every time.
3. Save raw pulls to a file and compute from the file. The weekly report does this for you.
4. Report in plain words, no jargon without a one-line meaning. Full analysis text in the chat message.
5. Never call a change "done" until a re-read shows it live.

---

## 1. Ground rules

1. **Data first, opinions second.** Pull the numbers before saying anything. If a number is not
   available, say "not tracked" instead of guessing.
2. **Know the real goal.** Ask once: what counts as a win (a booked call, an opt-in, a sale)? Judge every
   campaign on THAT, not on clicks or impressions. Save it as goalActions in config.json.
3. **Know what the business sells.** Before calling a search term good or bad, confirm the business
   offers it. When unsure, ask the owner one specific question.
4. **Read-only by default.** Analysis never changes the account. Changes are proposed, run as a dry run,
   and applied only after the owner's plain "yes". The one standing exception is the daily negatives
   sweep in "auto" mode, which the owner turns on once (skills/negative-keywords/SKILL.md).
5. **Money moves need an explicit yes.** Turning a campaign on, raising a budget, or changing bidding
   always needs the owner's approval, even when the data clearly supports it.
6. **Compare fair time windows.** Look at 30 days, 90 days and lifetime side by side.
7. **Watch for pauses.** A restart sends automated bidding back into "learning", so recent numbers look
   worse than they are.

---

## 2. Access (one-time setup)

The pack uses the Google Ads API with the owner's own Google login (one "Allow" click, a permanent
refresh token stored in $GADS_HOME/secrets, never in code or chat). `node pack.mjs doctor` shows what is
missing. Requests need the 10-digit customer id (no dashes) and, through a manager account, the manager
id (`node pack.mjs set --manager <id>`).

Queries are written in GAQL (Google Ads Query Language). Costs come back in micros: divide by 1,000,000.

No API access yet? Export the same reports from the Google Ads screens as CSV. The method is the same.

---

## 3. The data pull

`M` = `metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions`
`D` = `segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` (once per window: 30d, 90d, lifetime)

Run any of these with `node pack.mjs ads query "<GAQL>"`.

| What | GAQL |
|---|---|
| Campaign totals | `SELECT campaign.id, campaign.name, M FROM campaign WHERE D` |
| Conversions by action | `SELECT campaign.id, segments.conversion_action_name, metrics.conversions FROM campaign WHERE D` |
| By network (Search, Display, YouTube...) | `SELECT campaign.id, segments.ad_network_type, M FROM campaign WHERE D` |
| Campaign settings | `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign_budget.amount_micros, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status != 'REMOVED'` |
| Monthly trend | `SELECT campaign.id, segments.month, M FROM campaign WHERE D` |
| Keywords | `SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, M FROM keyword_view WHERE D` |
| Quality Score | `SELECT ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ad_group_criterion.final_urls FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'` |
| Search terms (Search) | `SELECT campaign.id, search_term_view.search_term, segments.keyword.info.text, M FROM search_term_view WHERE D` |
| Search terms (Performance Max) | `SELECT campaign_search_term_view.search_term, M FROM campaign_search_term_view WHERE campaign.id = <id> AND D` |
| Existing negatives | `SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE` |
| Ads and copy | `SELECT campaign.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, M FROM ad_group_ad WHERE D` |
| PMax asset groups | `SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength, asset_group.final_urls, metrics.clicks, metrics.cost_micros, metrics.conversions FROM asset_group WHERE D` |
| PMax assets + approval | `SELECT asset_group.name, asset_group_asset.field_type, asset_group_asset.status, asset_group_asset.policy_summary.approval_status, asset.id, asset.type, asset.text_asset.text FROM asset_group_asset` |
| Placements | `SELECT campaign.id, detail_placement_view.display_name, detail_placement_view.placement_type, detail_placement_view.target_url, M FROM detail_placement_view WHERE D` |
| Devices | `SELECT campaign.id, segments.device, M FROM campaign WHERE D` |
| Day of week / hour | `SELECT campaign.id, segments.day_of_week, M FROM campaign WHERE D` (and `segments.hour`) |
| Age / gender | `SELECT campaign.id, ad_group_criterion.age_range.type, M FROM age_range_view WHERE D` (and `gender_view`) |
| Locations | `SELECT campaign.id, segments.geo_target_region, metrics.clicks, metrics.cost_micros, metrics.conversions FROM user_location_view WHERE D` |
| Conversion actions | `SELECT conversion_action.name, conversion_action.status, conversion_action.primary_for_goal, conversion_action.category FROM conversion_action` |

---

## 4. The math (every campaign, network and window)

- **CTR** = clicks / impressions
- **CPC** = cost / clicks
- **Conversion rate** = conversions / clicks
- **Cost per result (CPA)** = cost / conversions of the REAL goal action only
- **Share of spend** = this row's cost / total cost
- **Share of results** = this row's conversions / total conversions

Count only the conversion actions that match the goal. Page views, subscribes or old test actions make
the cost per result look fake-good.

---

## 5. What to look for

**A. Where the money goes**
1. Spend share vs results share, by campaign and by network. The single most useful table.
2. Campaigns with real spend and zero goal results.
3. Campaigns optimizing for the wrong goal (views or subscribers counted as leads).

**B. Tracking health**
1. Is the primary goal action firing? A primary action with 0 conversions ever is a red flag.
2. Old, removed or duplicate actions in the goal list.
3. Is the deeper result tracked (call answered, appointment kept, purchase)? If only form fills count,
   Google finds form fillers, not customers.

**C. Search terms (the biggest money leak)**
1. Sort by cost. Flag terms with spend and no results.
2. Flag wrong intent: calculator, free, jobs, salary, how to, definition, competitor names, products the
   business does not sell.
3. Block them with negatives. The rules are in skills/negative-keywords/SKILL.md, and the daily sweep does most of it.

**D. Keywords (Search campaigns)**
1. Quality Score and its 3 parts (expected CTR, ad relevance, landing page). A low landing-page score
   usually means the ad sends people to the wrong page.
2. Check intent on live Google results. Articles and definitions on top mean the searcher is learning,
   not buying. Buyer keywords show service pages, providers, prices, "near me".
3. Two keywords that pull up mostly the same results compete with each other. Keep the stronger one.

**E. Placements (Display, YouTube, PMax)**
1. Sort outside sites and apps by cost. Flag sweepstakes, rewards, paid surveys, game apps, kids' content
   and parked domains.
2. Exclude them at account level (`ads exclude-placements`) and recheck monthly.

**F. Ads and assets**
1. Disapproved or limited ads and assets, and why. Replace them.
2. Ad strength. PMax: fill 15 headlines, 5 long headlines, 5 descriptions, landscape, square and portrait
   images, and at least one video.
3. Every ad must send people to the real conversion page.

**G. Who, when, where**
1. Devices, days, hours, ages, genders, locations: look for slices with high spend and no results. Act
   only with enough data (spend of at least 2 to 3 times the target cost per result).
2. Locations outside the area the business serves.

**H. Bidding and stability**
1. Target CPA needs steady conversions (about 30 or more a month) and no recent pauses. Under that, use
   Maximize Conversions. Set a Target CPA near the real average, not a wish number.
2. Leave a working campaign on for 30 days straight.
3. Raise budgets about 20% at a time and watch cost per result after each step.

---

## 6. Decision rules

- **Keep / scale:** most of the results at an acceptable cost per result. Scale slowly (20% steps).
- **Fix:** good results with leaks (bad search terms, junk placements, disapproved assets, missing tracking).
- **Stop:** real spend, zero goal results, and no tracking problem that explains it.
- **Rebuild before restarting:** aimed at informational keywords, wrong landing page, or poor Quality
  Score across the board.
- **Ask the owner** when the call depends on what they sell ("Do you offer X? If yes, these are cheap
  buyer clicks. If no, I will block them.").

The weekly report uses these lines: Stop = no goal results in 90 days and spend of at least twice the
target cost per result ($100 when there is no target yet). Keep = results in 30 days at up to 1.25 times
the target. Everything else with spend = Fix.

---

## 7. The report (plain words, numbers first)

`node pack.mjs report weekly` builds it and saves it to $GADS_HOME/data/reports/YYYY-MM-DD.md. It has:

1. **The short version:** total spend, total results, cost per result, what works, biggest leak.
2. **Every campaign:** spend, results, cost per result, 30d and 90d.
3. **Where every dollar went:** by network, spend share vs results share.
4. **Search terms** that spent money with no results.
5. **Keywords** with low Quality Score.
6. **Placements** with spend and no results.
7. **Ads and assets:** disapproved or limited.
8. **Tracking:** which actions count.
9. **Recommendations:** each labeled Keep / Fix / Stop, with the number behind it.
10. **One question for the owner** where the answer changes the decision.

For a deeper audit, add sections 5.D (live intent), 5.G (timing, devices, locations) from the queries
in section 3. Send the owner the short summary; the full file is there when they want it.

---

## 8. Applying approved changes (only after a yes)

Dry run first, then the same command with --confirm. Then re-read to confirm it is live.
1. Negatives: `ads negatives` / `ads account-negatives` (the target guard refuses anything that would block a target).
2. Placement exclusions: `ads exclude-placements`.
3. Remove PMax assets: `ads remove-assets` (the asset stays in the library, only the link goes).
4. Pause / enable: `ads pause` / `ads enable`.
5. Budget: `ads budget`.

Recheck the numbers after 7 and 30 days.

---

## 9. Building a campaign (never spends without the owner's yes)

The full setup, every setting and why, is in **skills/google-ads-campaign-setup/SKILL.md**. Read it first.

    node pack.mjs campaign template                          # the owner's own copy of the campaign sheet
    node pack.mjs campaign plan --sheet <copy link> --goal booked|optin|sales --type search|pmax --budget <daily $> \
      --geo "<City, State>" [--radius <miles>] --landing <https url> [--audiences "a|b"] [--phone "..."]
    node pack.mjs campaign plan --keywords "a,b,c" [--broad "one long keyword"] [--headlines "a|b"] [--descriptions "a|b"] \
      [--sitelinks "Text|url|desc|desc;;..."] [--callouts "a|b"] [--snippets "a|b"] ...   # same, without a sheet
    node pack.mjs campaign create ...same flags... --confirm

The builder always:
1. Builds the campaign **PAUSED**, starting the next **Monday**. Turning it on is `ads enable --campaign <id> --confirm`, after the owner's yes.
2. Search campaigns: **Google Search only**. No Display network, no search partners.
3. Bidding: Search starts on **Maximize Clicks with a max cost per click** (--max-cpc, default $10). The budget
   should buy 5 to 10 clicks a day (cost per click x 5). After 30+ goal conversions a month, the plan says so:
   ask the owner before switching to Maximize Conversions. PMax uses Maximize Conversions.
4. Conversion goal: ONE action for the goal ("Booked Call" when it exists). It refuses to build when no
   matching conversion action exists (set up tracking first).
5. Location: **presence** (people IN the area), never "interested in". The city itself, never the whole country by accident.
6. Ad schedule: all day unless the owner says otherwise. Ad rotation: optimize.
7. Keywords: **exact match** buyer keywords plus at most **one broad keyword of 4+ words** per ad group.
   Informational keywords are refused.
8. Responsive search ads: 15 headlines (30 characters max) and 4 descriptions (90 characters max) per ad group.
   Write real copy (from the sheet or --headlines/--descriptions); the builder checks lengths, duplicates, "!" in
   headlines, long dashes and ALL CAPS. Never invent facts (awards, years, prices) that the owner did not give you.
9. Assets: 2 to 4 sitelinks, about 10 callouts, a "Service catalog" structured snippet and the phone number.
10. Audiences on **observation only** (--audiences), so they track data and never narrow the ad.
11. **Standard, industry and company negatives** attached at creation (skipping any that would block the new keywords).
12. Google checks the whole build first (validateOnly). If Google rejects a field, the error is printed
    and nothing is created.

Performance Max also needs: 3 to 15 headlines, 1 to 5 long headlines (90 characters), 2 to 5 descriptions
(one 60 characters or less), a business name (25 characters), a square logo, at least one landscape image
(1.91:1) and one square image (1:1). Search themes default to the keywords. If images are missing, the
plan stops and lists exactly what the owner must provide.

Before you show the owner a plan, read it top to bottom. Then ask for one yes: "Build it paused?" Then,
separately, "Turn it on?" with the daily budget in the question.
