# INSTALL (for the bot: Claude Code on the owner's computer, or a bot on a VPS)

You are installing the Google Ads Pack for your owner. Do every step yourself. Only stop to ask the owner for the things in OWNER-GUIDE.md, one at a time, with the exact link and clicks.

## 1. Get the pack (needs git and Node 18+)
```
git clone https://github.com/william-moon/google-ads-pack.git ~/google-ads-pack
cd ~/google-ads-pack && node tools/verify-pack.mjs
```
If Node is missing or older than 18: install it (Linux: your package manager or nodejs.org; Mac: `brew install node`; Windows: `winget install OpenJS.NodeJS.LTS`). If git is missing, install it the same way.
Settings and data go to `~/.google-ads-pack` (override with the `GADS_HOME` environment variable). Updates never touch that folder.

## 2. Install the skills
Link (do not copy) each folder in `skills/` into your skills folder, so every update reaches you by itself.
- Claude Code (Mac/Linux): `mkdir -p ~/.claude/skills && for d in ~/google-ads-pack/skills/*/; do ln -sfn "$d" ~/.claude/skills/$(basename "$d"); done`
- Claude Code (Windows PowerShell): `New-Item -ItemType Junction -Path "$HOME\.claude\skills\<name>" -Target "$HOME\google-ads-pack\skills\<name>"` for each folder.
- Another bot: load `skills/*/SKILL.md` as your instructions for Google Ads work, and re-read them after each update.
Also install Anthropic's official `frontend-design` skill (used with `landing-page-design`). In Claude Code: `/plugin install frontend-design@claude-plugins-official`. If that name is not found, add the `anthropics/claude-code` plugin marketplace and install `frontend-design` from it.
Add one line to your own standing instructions (CLAUDE.md or system prompt): "For any Google Ads, GA4, GTM, Clarity, conversion or ad landing page task, use the google-ads-pack skill first and run `node ~/google-ads-pack/pack.mjs doctor`."

## 3. Set up (follow the doctor)
```
node ~/google-ads-pack/pack.mjs doctor
```
It prints what is done and the NEXT step. Repeat until it says ALL SET. The full order is in `skills/google-ads-pack/SKILL.md`.
- Owner on the same computer (Claude Code): use `connect --client <file> --listen` so the Allow click finishes by itself.
- Bot browser (screen control for the steps with no API): `node pack.mjs browser setup`, then `node pack.mjs browser login` once (the owner signs in to Google and their website). It is a real Chrome with its own profile, hidden, separate from the owner's own Chrome. On a Linux server with no screen it runs headless. Use it only on a computer or server that nobody else logs in to (its control port is local, but any program on that machine could use it while it runs).
- VPS bot: the owner clicks the links on their phone or computer and sends you back what you ask for (the client file, the address after Allow, the Clarity project ID and key).

## 4. Turn on the daily jobs
```
node ~/google-ads-pack/pack.mjs schedule
```
This adds 2 jobs: `daily` at 6:30 AM (Clarity data, negatives sweep, weekly report on Mondays) and `update` at 5:30 AM. If you can message your owner, run `node pack.mjs set --notify "<command that reads the message on stdin and sends it>"` so the daily summary reaches them. If this is Claude Code with no cron (Windows without Task Scheduler rights), create the same 2 scheduled tasks with your own scheduler.

## 5. Updates
`node pack.mjs update` downloads the newest pack and checks it BEFORE using it: the file list must be signed by the release key already on this computer (`release-key.pub`) and every file must match. A version that fails is never used. (Installed before 2026.11.12? Reinstall once with the git command above.) After an update, read `CHANGELOG.md` and follow anything new.

## Rules
Never print or send tokens, client secrets, or the Clarity key. Every live change is a dry run until `--confirm`. Money moves (turning on, budgets, bidding) need the owner's yes. No em dashes or en dashes in anything you write for the owner.
