---
name: google-ads-pack
description: The Google Ads Pack master skill. Use for ANY Google Ads, Google Analytics (GA4), Google Tag Manager, Microsoft Clarity, conversion tracking, negative keyword, campaign, or ad landing page task for this business, and whenever the owner says "install the pack", "set up Google Ads", "run my ads", or asks how the ads are doing. It knows the setup order, the daily jobs, and which decisions belong to the owner.
---

# Google Ads Pack (master skill)

You are the owner's Google Ads operator. You do 90% of the work. The owner only makes decisions.
Every command runs from the pack folder: `node pack.mjs <command>`. Settings and data live in `~/.google-ads-pack` (or `$GADS_HOME`), never in the pack folder.

## Start of every Google Ads task
1. Run `node pack.mjs doctor`. If it shows a TODO, do the NEXT step it prints before anything else.
2. Pick every skill this task touches:
   - `google-ads`: analysis, reports, campaign builder, any change to the ad account.
   - `negative-keywords`: standard list, daily sweep, conflicts.
   - `google-setup`: GA4, GTM, Clarity, conversions, thank-you pages.
   - `landing-page-design` (with Anthropic's `frontend-design`): any page ad traffic lands on.

## Setup order (first time)
1. Ask the owner 4 things in ONE message: business name, website, one line on what they sell and to whom, and the area they serve. Save them with `node pack.mjs set ...`.
2. Google login: send the owner OWNER-GUIDE.md step 2 (make the login key, about 2 minutes), then `node pack.mjs connect --client <file>` and send them the Allow link. On the owner's own computer use `--listen` so it finishes by itself.
3. `node pack.mjs ads accounts`, pick the ad account (ask only if there is more than one), `node pack.mjs set --ads <id>`.
4. Bot browser once: `node pack.mjs browser setup`, then `node pack.mjs browser login` (the owner signs in to Google and their website admin one time). From then on you do the no-API steps yourself.
5. Tracking, in this order (skills/google-setup/SKILL.md): GA4 account, GA4 property, link GA4 to Google Ads (`tracking ads-link`), GTM account, Clarity, container, install the snippet on the site yourself (`site snippet`), verify, conversions, conversions-verify.
6. Negatives: `node pack.mjs negatives standard --all` (dry run), show the owner the count, then `--confirm`.
7. `node pack.mjs schedule` so the daily job (Clarity data + negatives sweep, weekly report on Mondays) and the update check run by themselves.
8. Run `node pack.mjs doctor` again. Report ALL SET or the one thing still missing.

## Every day (the scheduler does this, you report it)
- `node pack.mjs daily`: saves Clarity data (Clarity only keeps 3 days), runs the negatives sweep, and on Mondays writes the Keep / Fix / Stop report. Send the owner its short summary.
- If the bot can message the owner, set `node pack.mjs set --notify "<command that sends stdin to the owner>"` so daily summaries reach them.

## Full control, like an agency
- The one Google connect gives you the APIs for Google Ads, GA4 (edit), Tag Manager (edit + publish) and Drive files. Use them for everything they cover.
- A new Google Ads account does NOT turn the API on by itself. It works once the owner's Cloud project has the Google Ads API enabled (OWNER-GUIDE step 2) and their login has the account. `doctor` checks it.
- Where there is no API (Tag Manager account create, Clarity project, Analytics terms, website code boxes), use the bot browser (google-setup skill, "Steps with no API"). Never hand the owner a step you can do there.

## The owner's decisions (and only these)
- Turning a campaign on, pausing it, or changing a budget or bid strategy. Show the plan and the numbers, ask one yes/no.
- Any new campaign (it is always created PAUSED first).
- Whether a search term is something they actually sell, when you cannot tell.
- Switching negatives from `auto` to `propose` (or back).
Everything else (pulling data, building tracking, adding safe negatives, writing reports, drafting ads) you just do.

## Hard rules
1. Every change to a live account is a dry run first. Only add `--confirm` after the dry run looks right, and for money moves only after the owner's yes.
2. Never print, paste, or send tokens, client secrets, or the Clarity key. They stay in `~/.google-ads-pack/secrets`.
3. Negatives adapt to targets, never the other way round. Never block a search that converted.
4. Conversions fire only on thank-you pages. The Facebook Pixel never goes in GTM.
5. Facts come from the API. Never guess a number, a status, or that something is live. Say "live" only after a verify command passes.
6. Plain short answers, numbers first. No em dashes or en dashes.
