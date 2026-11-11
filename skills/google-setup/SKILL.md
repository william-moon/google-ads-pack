---
name: google-setup
description: Set up and check Google tracking for a business website. Use whenever the owner mentions GA4, Google Analytics, GTM, Google Tag Manager, the Google container, linking Google Ads to GA4 (Google Ads links, product links), installing the tracking code or snippet on the website, tracking, analytics setup, Microsoft Clarity, heatmaps or recordings, Google Ads conversions, conversion tracking, or a thank-you page. Builds GA4, a GTM container with the standard template, the Clarity tag with a daily data pull, and the Opt In and Booked Call conversions. Every live change is a dry run until --confirm.
---

# Google setup: GA4, Tag Manager, Clarity, Ads conversions

All commands run from the pack folder. Every step saves its ids in `$GADS_HOME/config.json`
(default `~/.google-ads-pack`), so later steps need fewer flags.

## The order

1. **Connect Google once.** `node pack.mjs connect`. One Allow covers Ads, Analytics, Tag Manager and Drive files.
   Also once: `node pack.mjs browser setup` and `node pack.mjs browser login` (the bot's own hidden Chrome; the owner signs in
   to Google and to their website admin one time). It lets you do the few steps Google has no API for yourself.
2. **GA4 account.** `node tools/tracking.mjs ga4-account --name "<Business>" --confirm`.
   It reuses an account with that exact name. If none exists, it creates it and clicks I Accept on the Terms page itself
   in the bot browser. Only if that fails does it print the Terms link for the owner. Check with
   `node tools/tracking.mjs ga4-account --name "<Business>" --check`.
3. **GA4 property.** `node tools/tracking.mjs ga4-property --name "<Business>" --domain example.com --confirm`.
   Add `--timezone America/Chicago` if the machine's time zone is not the business's. It saves the G- Measurement ID.
4. **Link GA4 to Google Ads** (only if the business runs Google Ads; skip for SEO only).
   `node tools/tracking.mjs ads-link --confirm`. This is GA4 Admin > Product links > Google Ads links > Link, done through
   the API: links the GA4 property to the ad account with Personalized Advertising ON and turns Auto-Tagging ON in Google Ads.
   Run it without `--confirm` any time: it prints PASS when the link is in place. Needs the ad account picked first
   (`node pack.mjs set --ads <id>`). If Google says 403, the login must be an Admin on the ad account.
5. **GTM account.** `node tools/tracking.mjs gtm-account --name "<Business>" --domain example.com --confirm`.
   Google has no API to create a Tag Manager account, so the tool fills Google's form itself in the bot browser
   (name, container = domain, Web, accept terms). Only if the bot browser is not set up or the form changed does it print
   a 1 minute form for the owner.
6. **Clarity.** Clarity has no create API. Do it yourself in the bot browser (connect with Playwright to
   `http://127.0.0.1:9333`, see "Steps with no API" below): sign in with the same Google account, New project (name + website),
   copy the Project ID (Settings > Overview), generate an API token (Settings > Data Export). Save it with
   `node tools/clarity.mjs save --project <id> --token-file <file>` (never put the token on the command line), then delete the file.
   Only if that fails, `node tools/clarity.mjs setup` prints the owner steps.
7. **Container.** `node tools/tracking.mjs container --domain example.com --confirm`.
   Locked template: 33 built-in variables, 0 user-defined, Conversion Linker and Google Tag (GA4) on All Pages,
   plus the Clarity tag. Safe to run again: it only adds what is missing, then publishes.
8. **Install the snippet yourself.** Never hand this to the owner.
   - WordPress: `node pack.mjs site snippet --wordpress --confirm` (installs the free Header Footer Code Manager plugin if needed,
     adds one site-wide "Google Tag Manager" snippet, then checks the live page).
   - Site files you can reach (static site, repo, hosting folder): `node pack.mjs site snippet --dir <folder> --confirm`, then publish the way the site is normally published.
   - Wix, Squarespace, Shopify, Webflow, GoDaddy and other builders: `node pack.mjs site snippet --print`, then paste the head code in
     that builder's custom code / header code setting yourself in the bot browser (the owner logged in to it once with `browser login`).
9. **Verify.** `node tools/tracking.mjs verify --url https://example.com/`. Must say PASS.
10. **Conversions** (only if the business runs Google Ads):
   `node tools/tracking.mjs conversions --goal both --optin-path /thank-you-optin --booked-path /thank-you-booked --confirm`.
   Opt In = Sign-up. Booked Call = Book appointment. Website conversion, count one, no value.
   With both, Booked Call is Primary and Opt In is Secondary. With only one, it is Primary.
   Each fires only on its own thank-you page. Never All Pages.
11. **Conversions verify.** `node tools/tracking.mjs conversions-verify --site https://example.com --optin-path ... --booked-path ...`.
    Must say VERIFY PASS. Then one look in Tag Manager Preview: home page fires no conversion, each thank-you page fires its own.
12. **Daily Clarity pull.** Add the cron line from the top of `tools/clarity.mjs`. `node tools/clarity.mjs report --days 7` gives a summary.

## Steps with no API: the bot browser (screen control)
Use the API first. When Google or a website has no API for a step, do it yourself on screen in the bot's own Chrome:
- `node pack.mjs browser status` shows if it is ready and signed in. `browser start` runs it hidden.
- In your own Playwright code: `import('<pack>/lib/browser.mjs')` and call `withPage(async (page) => { ... })`. It opens a new
  background tab, never the owner's normal Chrome, and never steals focus. Take a screenshot (`page.screenshot`) to see what you are doing.
- If it shows signed out, ask the owner once to run `node pack.mjs browser login` (or run it for them on their computer and tell them to sign in).
- One try per step. If the page asks for a 2-step code, a passkey or a captcha, stop and ask the owner; never loop sign-ins.

## Rules

- Every command that changes a live account is a dry run until you add `--confirm`. Show the owner the dry run first.
- Never put the Facebook Pixel in Tag Manager. It goes directly in the site HTML, with its events on the real thank-you page or button. In GTM it miscounts leads.
- No Hotjar. Clarity covers recordings and heatmaps for free.
- Clarity keeps only 3 days of data. The daily pull is required, or history is lost. It uses 3 of Clarity's 10 calls a day.
- A conversion trigger must be the thank-you page path. Never `/`, never All Pages. Two thank-you pages must not overlap.
- Making a conversion Primary changes what campaigns bid on. Say so plainly before `--confirm`.
- Never print, paste or log tokens or passwords. They live only in `$GADS_HOME/secrets/` (owner read only).
- Tag Manager allows about 30 calls a minute. The tool paces itself. Do not run two copies at once.
- If a step says something is not set up yet, run the step it names. Do not guess ids.
