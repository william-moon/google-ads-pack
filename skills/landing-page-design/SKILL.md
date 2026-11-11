---
name: landing-page-design
description: Use whenever you build or edit an ad landing page, thank-you page, or any page Google Ads traffic lands on. Works together with Anthropic's official frontend-design skill (install it, see INSTALL.md). Adds the hard copy and layout rules plus the landing page checks that make ads convert.
---

# Landing Page Design (for ad traffic)

First load the official `frontend-design` skill and design to it (distinctive, intentional, never a template look).
Then apply every rule below. These rules win over any default style.

## Hard copy + layout rules (no exceptions)
1. Never use an em dash or an en dash anywhere (headlines, body, FAQ, meta, alt text, email). A normal hyphen in a compound word is fine. Scan before publishing: the count must be 0.
2. Body text is justified, the same across the whole page, hero included.
3. No more than 2 paragraphs per section. No more than 3 sentences per paragraph.
4. One sentence per line (a line break between sentences) so the page is light and easy to scan.
5. At most one bullet list on the page, only if it really helps.
6. FAQs are boxed cards with the question as an H3, never an accordion.
7. Plain words a 6th grader can read. Answer first, then explain.

## What an ad landing page must have
1. One goal per page: the same action the campaign optimizes for (book a call, or opt in). One main button, repeated.
2. The headline repeats the words of the ad and the keyword the person searched.
3. The offer, who it is for, and the area served are visible without scrolling.
4. Proof: real reviews, real photos of the owner and team. Never replace a real owner photo with stock art.
5. Phone number tap-to-call on mobile. Fast: test on a phone.
6. After the form or booking, send people to a THANK-YOU page with its own address (for example /thank-you-booked). Conversions fire only there. Never fire a conversion on every page.
7. The GTM container snippet is on every page. The Facebook Pixel, if used, goes directly in the page HTML, never through GTM.

## Before calling it done
1. Run `node pack.mjs tracking verify --url <page>` (GTM present).
2. Run `node pack.mjs tracking conversions-verify ...` (thank-you pages fire, home page does not).
3. Check the page on a phone width.
