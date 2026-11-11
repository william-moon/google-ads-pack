// google.mjs: the owner's OWN Google login for this pack (their own Cloud project + OAuth client).
// One "Allow" gives a permanent refresh token for Ads, Analytics (edit), Tag Manager (edit + publish) and Drive files.
import crypto from 'node:crypto';
import { secret, saveSecret, die } from './core.mjs';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.publish',
  'https://www.googleapis.com/auth/tagmanager.manage.accounts',
  'https://www.googleapis.com/auth/drive.file',
];
export const REDIRECT = 'http://localhost:8765/';

let cached = null;
export async function accessToken() {
  if (cached && cached.exp > Date.now() + 60e3) return cached.tok;
  const g = secret('google');
  if (!g?.refresh_token) throw Object.assign(new Error('Google is not connected yet. Run: node pack.mjs connect'), { exitCode: 3 });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!j.access_token) throw Object.assign(new Error(`Google login refresh failed (${j.error || r.status}). If it says invalid_grant, run: node pack.mjs connect again`), { exitCode: 3 });
  cached = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.tok;
}

// Plain JSON call to any Google API with the owner's token. Throws a short readable error.
export async function gapi(url, { method = 'GET', body, headers = {} } = {}) {
  const tok = await accessToken();
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 300) }; }
  if (!r.ok) {
    const d = j.error?.details?.find?.((x) => x.errors)?.errors?.[0];
    const e = new Error(`${r.status} ${d ? JSON.stringify(d.errorCode) + ' ' + d.message : j.error?.message || j.raw || ''}`.slice(0, 600));
    e.status = r.status; e.body = j; throw e;
  }
  return j;
}

// Each Allow link gets a fresh random state (stops a forged callback) and a PKCE secret (stops a stolen code).
export function authUrl(clientId) {
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  saveSecret('oauth-pending', { state, verifier, created: Date.now() });
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: SCOPES.join(' '),
    state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}
// gotState: the state in the address Google sent the owner to (null if they pasted only the code).
export function checkState(gotState) {
  const p = secret('oauth-pending');
  if (!p?.verifier || Date.now() - p.created > 30 * 60e3) throw new Error('That Allow link is old or was not made on this computer. Run connect again for a fresh link.');
  if (!gotState || gotState !== p.state) throw new Error('The answer from Google does not match the link this computer made (state mismatch). Ignored. Run connect again.');
  return p.verifier;
}
export async function exchange(client, code, verifier) {
  saveSecret('oauth-pending', {}); // one try per Allow link, success or not
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code', ...(verifier ? { code_verifier: verifier } : {}) }) });
  const j = await r.json();
  if (!j.refresh_token) throw new Error('Google did not return a permanent login (' + (j.error_description || j.error || 'no refresh_token') + '). Run connect again; it forces the consent screen.');
  let email = null; try { email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString()).email || null; } catch {}
  saveSecret('oauth-pending', {});
  saveSecret('google', { client_id: client.client_id, client_secret: client.client_secret, refresh_token: j.refresh_token, scopes: j.scope, account: email, connected: new Date().toISOString() });
  return email;
}
