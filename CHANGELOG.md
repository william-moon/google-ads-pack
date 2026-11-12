# Changelog
## 2026.11.13
- New skill: google-ads-campaign-setup. The full campaign setup we teach, for any business and any campaign type.
- Campaign builder: reads the owner's copy of the campaign sheet (--sheet) or a plan file (--plan); several ad groups; exact match plus one long broad keyword per ad group;
  Maximize Clicks with a max cost per click (default $10) for new Search campaigns; Monday start; observation audiences; sitelinks, callouts,
  service catalog snippet and call asset; industry and company negatives from the sheet; budget rule (cost per click x 5 clicks a day); city targeting.
- `campaign template` prints the make-a-copy link for the sheet.
## 2026.11.12
- New: `tracking ads-link` links GA4 to the Google Ads account (Personalized Advertising ON) and turns Auto-Tagging ON. In doctor and setup order.
- New: `site snippet` puts the Tag Manager code on the website itself (WordPress, a site folder, or paste in any builder through the bot browser).
- New: the bot browser (`pack.mjs browser`), the bot's own hidden Chrome for steps with no API. GA4 terms and Tag Manager account are now done by the bot.
- If you installed 2026.11.11, reinstall once with the git command in INSTALL.md (that version cannot check signed updates).
- Security: updates are signed and checked with the installed key before they are used; Google connect uses state + PKCE; settings files are owner-only;
  secrets can be passed with --*-file instead of on the command line; AI negatives treat search terms as data only and are capped per run.
## 2026.11.11
First release: connect, doctor, GA4 + GTM + Clarity setup, conversions, daily Clarity data, standard + daily negatives, campaign builder, weekly report, self-update.
