# Owner Guide: your part (about 5 minutes, one time)

Your bot does the rest. It sends you each step when it needs it, with the link.

## Before you start, have
1. The Google login that owns your Google Ads account, with billing set up in Google Ads.
2. Your website login (WordPress, Wix, Squarespace, Shopify...). The bot adds the tracking code itself.

## Step 1: Tell your bot 4 things
Your business name, your website, one line on what you sell and to whom, and the area you serve.

## Step 2: Make your Google login key (about 3 minutes)
This is your own key in your own Google account. Nobody else ever holds it.
1. Open https://console.cloud.google.com/projectcreate and name the project "Ads Bot". Click Create.
2. Open this link and click Enable: https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com,analyticsadmin.googleapis.com,analyticsdata.googleapis.com,tagmanager.googleapis.com,sheets.googleapis.com,drive.googleapis.com
3. Open https://console.cloud.google.com/auth/overview and click Get started. App name "Ads Bot", your email, Audience External, your email again, agree, Create.
4. Click Audience, then Publish app, then Confirm. (This keeps your login from expiring every 7 days.)
5. Click Clients, then Create client. Type: Desktop app. Click Create, then Download JSON.
6. Send that file to your bot.

## Step 3: Click Allow (10 seconds)
Your bot sends you a Google link. Pick the login that owns your ad account and click Allow. If Google says the app is not verified, click Advanced, then Go to Ads Bot. It is your own app. If your bot is on another server, copy the address your browser lands on (it may say "can't connect", that is normal) and send it to your bot.

## Step 4: Sign in once in your bot's browser (2 minutes)
Your bot has its own Chrome window, separate from yours. It uses it for the few things Google and Microsoft have no API for
(creating the Tag Manager account, accepting the Analytics terms, creating the Clarity project, putting the tracking code on your website).
1. Your bot opens that window (`node pack.mjs browser login`).
2. Sign in to the Google account that owns your ads.
3. In a new tab, log in to your website admin and tick "remember me".
4. Close the window. From now on the bot does those steps itself, hidden, and never touches your own Chrome.
If something in that window asks for a 2-step code, the bot asks you. If your bot runs on a server instead of your computer,
it sends you the one or two links it cannot click, the same as step 3.

## Step 5: Decide, the bot does the rest
From now on you only answer yes or no on things that spend money: turning a campaign on, budgets, and big changes. Every morning your bot saves your Clarity data, adds the negative keywords that waste your money, and on Mondays sends a Keep / Fix / Stop report.

## Does making a Google Ads account turn on the API?
No. Making the ad account is not enough. Your bot can control it after step 2 (your login key, with the Google Ads API enabled)
and step 3 (Allow). The same Allow covers Google Ads, Analytics, Tag Manager and Drive, so you never do it again.
Your bot also links Analytics to your ad account (Personalized Advertising and Auto-Tagging on) by itself.

## If Google asks for a developer token or "API access"
Open https://console.cloud.google.com/apis/api/googleads.googleapis.com in your Ads Bot project and follow the access prompt Google shows there. If Google still asks for a developer token, open Google Ads, Admin, API Center (needs a manager account, free at https://ads.google.com/home/tools/manager-accounts/), copy the token, and send it to your bot.
