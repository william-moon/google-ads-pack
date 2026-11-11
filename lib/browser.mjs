// browser.mjs: the bot's own hidden Chrome on the owner's computer, for the few Google and website
// steps that have no API (Tag Manager account, Analytics terms, Clarity project, website code box).
// It is a REAL Chrome (not headless) with its own profile in $GADS_HOME/browser, so logins stick and
// the owner's normal Chrome is never touched. It runs minimized/off screen and never steals focus.
// The DevTools port listens on 127.0.0.1 only. Any program on THIS computer could use it while it runs, so use the
// bot browser only on a computer (or server) that only the owner uses. `node pack.mjs browser stop` closes it.
//
// One time: node pack.mjs browser setup   (installs playwright-core into $GADS_HOME, no browser download)
//           node pack.mjs browser login   (opens it visibly once; the owner signs in to Google and their website)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HOME } from './core.mjs';

export const PORT = Number(process.env.GADS_BROWSER_PORT || 9333);
export const PROFILE = path.join(HOME, 'browser');
const PW_DIR = path.join(HOME, 'node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromePath() {
  if (process.env.GADS_CHROME) return process.env.GADS_CHROME;
  const c = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32' ? [path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'), path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return c.find((p) => p && fs.existsSync(p)) || null;
}

export async function running() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Start the bot's Chrome. visible=true only for the one-time login.
export async function start({ visible = false, url = 'about:blank' } = {}) {
  if (await running()) return true;
  if (visible && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('This computer has no screen, so the one-time sign-in cannot be shown here. Install the pack on the owner\'s own computer for the bot browser, or use the owner links the tools print.');
  const exe = chromePath();
  if (!exe) throw new Error('Google Chrome is not installed on this computer. Install it from google.com/chrome, or set GADS_CHROME to its path.');
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    ...(visible ? [] : ['--start-minimized', '--window-position=-2400,-2400', '--window-size=1280,900']),
    // A Linux server with no screen: run headless (Linux has no keychain problem, so saved logins still work).
    ...(process.env.GADS_CHROME_ARGS ? process.env.GADS_CHROME_ARGS.split(' ').filter(Boolean) : []),
    ...(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? ['--headless=new'] : []), url];
  if (process.platform === 'darwin') {
    // -g = do not bring to front, -j = launch hidden, -n = new instance (separate from the owner's own Chrome).
    const appDir = exe.replace(/\/Contents\/MacOS\/.*$/, '');
    spawnSync('open', [...(visible ? [] : ['-g', '-j']), '-n', '-a', appDir, '--args', ...args], { stdio: 'ignore' });
  } else {
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: !visible }).unref();
  }
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await running()) return true; }
  throw new Error(`Chrome started but its control port ${PORT} did not answer. Run: node pack.mjs browser stop (or close any Chrome window using ${PROFILE}) and try again. (On a Linux server whose Chrome reports "No usable sandbox", set GADS_CHROME_ARGS="--no-sandbox".)`);
}

export async function stop() {
  const v = await running(); if (!v) return false;
  const pw = await playwright();
  const b = await pw.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try { const s = await b.newBrowserCDPSession(); await s.send('Browser.close'); } catch {}
  return true;
}

export async function playwright() {
  const p = path.join(PW_DIR, 'node_modules', 'playwright-core', 'index.mjs');
  if (fs.existsSync(p)) return import(pathToFileURL(p).href);
  try { return await import('playwright-core'); } catch {}
  try { return await import('playwright'); } catch {}
  throw new Error('The browser helper is not installed yet. Run: node pack.mjs browser setup');
}

export function setup() {
  fs.mkdirSync(PW_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(PW_DIR, 'package.json'))) fs.writeFileSync(path.join(PW_DIR, 'package.json'), '{"private":true}\n');
  // playwright-core only: it drives the Chrome already on this computer and downloads no browsers. No shell (safe folder names).
  const args = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', PW_DIR, 'playwright-core@1.65.0'];
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = process.platform === 'win32' && fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm install playwright-core failed. Is Node with npm installed?');
}

// Run fn(page) in a NEW background tab of the bot's Chrome, then close the tab and disconnect (Chrome keeps running).
export async function withPage(fn, { visible = false } = {}) {
  await start({ visible });
  const pw = await playwright();
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try { return await fn(page); }
  finally { try { await page.close(); } catch {} try { await browser.close(); } catch {} }
}

// True if the bot's Chrome is signed in to a Google account.
export async function googleSignedIn() {
  return withPage(async (p) => {
    await p.goto('https://myaccount.google.com/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500);
    const u = new URL(p.url()); // signed out lands on accounts.google.com or www.google.com/account/about
    return u.hostname === 'myaccount.google.com';
  });
}
