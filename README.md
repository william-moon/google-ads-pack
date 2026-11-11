# Google Ads Pack

A skill pack that lets a business owner's AI bot (Claude Code, or a bot on a VPS) run their Google Ads the way a careful agency would:
1. Connects the owner's own Google login once (Ads, Analytics, Tag Manager, Drive).
2. Creates the GA4 account and property, the Tag Manager container (Conversion Linker, GA4, Microsoft Clarity), and publishes it.
3. Sets up conversions the right way: Opt In (secondary) and Booked Call (primary), firing only on thank-you pages, then proves it.
4. Saves Microsoft Clarity data every day to a Google Sheet in the owner's Drive plus a local file (Clarity only keeps 3 days).
5. Adds standard negative keywords on day one, then sweeps search terms every day and blocks the ones that waste money, without ever blocking what the owner targets.
6. Plans and builds campaigns (always paused until the owner says yes) and writes a weekly Keep / Fix / Stop report.

The owner only makes decisions. Start here:
- Bot: read INSTALL.md.
- Owner: read OWNER-GUIDE.md (about 5 minutes, one time).

Nothing in this pack holds anyone's logins. Each owner's keys stay on their own machine in `~/.google-ads-pack/secrets`.

Also: links GA4 to Google Ads, puts the tracking code on the website itself, and has its own hidden browser for the few steps Google has no API for. Updates are signed.
