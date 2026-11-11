---
name: negative-keywords
description: >
  Negative keywords for Google Ads: the standard list on every campaign, the daily search-term sweep,
  and the target guard. Use whenever anyone mentions negative keywords, wasted spend on search terms,
  bad or irrelevant searches, blocking competitors, informational searches, or the daily negatives job.
---

# Negative keywords

A negative keyword tells Google "do not show my ad for this search". Good negatives stop money leaking
to people who will never buy. Bad negatives silently kill good traffic. These rules keep both in check.

Match types: `word` = broad (blocks any search with all those words), `"a phrase"` = phrase (blocks
searches with those words in that order), `[exact words]` = exact (blocks only that search).
Negatives do not match close variants, so "job" does not block "jobs".

## The commands

    node pack.mjs negatives standard [--campaign <id>] [--confirm]   # standard list, account level + every campaign
    node pack.mjs negatives sweep [--days 3] [--confirm]              # the daily job
    node pack.mjs negatives apply [--date YYYY-MM-DD] [--confirm]     # add a day's proposals (propose mode)
    node pack.mjs negatives conflicts [--confirm]                     # remove negatives that block a target
    node pack.mjs ads negatives --campaign <id> --kw "..." [--confirm]   # add your own, one campaign

Without --confirm every command is a dry run that Google checks.

## The rules

1. **Standard negatives on every campaign, from day one.** The pack's list (data/standard-negatives.json,
   138 words) goes on the account-level negative list AND as campaign-level broad negatives on every
   Search and Performance Max campaign. `negatives standard --confirm` does both. The campaign builder
   attaches them at creation. A word that is part of the business's own targets is skipped (put it in
   standardSkip in config.json to skip it for good).
2. **Negatives adapt to targets, never the reverse.** Targets = PMax search themes, enabled keywords,
   config.json "targets" and "protect" (brand words). Every tool refuses a negative that would block one
   of them, and says why. After changing keywords or themes, run `negatives conflicts` (dry), then
   `--confirm`: it removes every blocking negative and re-adds account-level words on the other campaigns
   where they do no harm.
3. **Never block a search that converted.** The sweep skips any search with a conversion, and refuses any
   negative that would block a search that ever converted.
4. **No informational searches.** People learning are not buying: what is, how to, why, rules, limits,
   calculator, definition, examples, DIY, reddit, youtube, wiki, pdf, template, course, free. Unless the
   owner runs an informational strategy on purpose.
5. **No job seekers.** jobs, salary, career, hiring, resume, internship.
6. **No competitor or other-company searches by default.** Names in config.json "competitors" are blocked
   as a word (or phrase). Without the list, the sweep only blocks clear signs: a web address, LLC or Inc,
   or "login", "customer service", "phone number" after another name. Searches with the owner's own brand
   words are never touched.
7. **No off-niche searches.** Products or services the business does not sell. Put known ones in
   config.json "offNiche" (blocked as a word). Others are found as the campaign runs (rule 9).
8. **Narrowest negative wins.** A single broad word only when that word is always bad (jobs, salary,
   free, diy, reddit, youtube, wiki, pdf, template...) or the owner listed it (competitors, offNiche).
   Everything else is an [exact] negative of the full search, so good searches that share words keep running.
9. **Niche negatives, found as the campaign runs.** The daily sweep reads the last 3 days of searches.
   Rules catch the common cases. If GADS_AI_CMD is set (for example `claude -p --tools ""`, an AI call with NO tools, because search terms are typed by strangers and are only data), the searches the rules
   could not decide (spend, no conversions) go to the AI with the business description, and its answer
   passes the same guards before anything is added.

## The daily sweep

`node pack.mjs daily` runs it every morning (installed by `node pack.mjs schedule`).

1. Pulls search terms for the window: search_term_view for Search, campaign_search_term_view for PMax.
2. Drops searches already blocked, and any search with a conversion.
3. Classifies the rest: informational, jobs, competitor, off-niche (then the optional AI pass).
4. Runs every pick through the target guard (targets, brand words, converted searches).
5. **Mode** (config.json negativesMode, set with `node pack.mjs set --negatives auto|propose`):
   - `auto` (the default): the daily job adds them (it runs the sweep with --confirm).
   - `propose`: nothing is added. The bot sends the list; after the owner's yes, run
     `negatives apply --date <day> --confirm`.
6. Saves everything to $GADS_HOME/data/negatives/YYYY-MM-DD.json and one line per item to
   negatives/ledger.csv (added, proposed or refused, with the reason and the cost).
7. Prints one short summary that the bot sends the owner, for example:
   "Added 7 negatives today: jobs, [what is a heat pump], "big competitor" (+4 more). Skipped 2 that would
   block your targets, brand or a search that converted."

## When the owner asks "why did you block X?"

Find it in negatives/ledger.csv: it shows the search, the negative, the category and the reason. To undo
one, remove it in Google Ads (or ask the bot) and add the word to config.json "targets" so it is never
blocked again.
