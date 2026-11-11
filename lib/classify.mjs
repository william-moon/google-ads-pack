// classify.mjs: pure rules for negative keywords. No network, no files, so it is easy to test.
//   classifyTerm(term, ctx)   -> null (keep) or { term, category, negative, reason }
//   guardNegative(neg, ctx)   -> null (safe) or a reason string (refuse)
//   parseNeg / fmtNeg         -> "word" = BROAD, "\"a b\"" = PHRASE, "[a b]" = EXACT
// ctx = { targets: [], protect: [], competitors: [], offNiche: [], converted: [] }  (all lower case is not required)
import { blocks, kwMatch, kwText } from './ads.mjs';

export const toks = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}'&$.]+/gu) || [];
export const norm = (s) => toks(s).join(' ');
export const parseNeg = (k) => [kwText(String(k).trim()).toLowerCase(), kwMatch(String(k).trim())];
export const fmtNeg = (text, match) => (match === 'PHRASE' ? `"${text}"` : match === 'EXACT' ? `[${text}]` : text);

// Words that are bad for almost every business that sells something. When one shows up, a BROAD
// negative of just that word is safe (the target guard still refuses it if the owner targets it).
export const ALWAYS_BAD = {
  jobs: ['job', 'jobs', 'salary', 'salaries', 'career', 'careers', 'hiring', 'employment', 'internship', 'internships', 'resume', 'glassdoor', 'indeed', 'apprenticeship'],
  informational: ['diy', 'reddit', 'youtube', 'wiki', 'wikipedia', 'quora', 'pdf', 'template', 'templates', 'definition', 'define', 'meaning', 'free', 'tutorial', 'tutorials', 'worksheet'],
};
// Signs of a learning search. These are NOT always bad on their own, so they get an [exact] negative of the full search.
const INFO_PHRASES = ['what is', 'what are', 'what does', 'what do', 'what happens', 'how to', 'how do', 'how does', 'how can', 'how is', 'how long', 'how many', 'why', 'when to', 'when do', 'when can', 'is it', 'can you', 'can i', 'should i', 'do i need', 'difference between', 'explained'];
const INFO_WORDS = ['rules', 'rule', 'limits', 'limit', 'calculator', 'calculate', 'formula', 'examples', 'example', 'course', 'courses', 'class', 'classes', 'certification', 'guide', 'history', 'statistics', 'stats', 'ideas', 'tips', 'facts', 'news', 'requirements', 'laws', 'law', 'chart', 'table', 'quiz', 'essay', 'synonym', 'vs', 'versus'];
// Signs someone is looking for one specific other company (login, phone number, customer service).
const COMPANY_PHRASES = ['login', 'log in', 'sign in', 'customer service', 'phone number', 'contact number', 'headquarters', 'stock price', 'careers page', 'my account', 'app download'];
const COMPANY_TOKENS = /^(?:[\p{L}\p{N}-]+\.(?:com|net|org|io|co|us)|llc|inc|corp|ltd|incorporated)$/u;

const has = (s, phrase) => (' ' + s + ' ').includes(' ' + phrase + ' ');
const lc = (a) => (a || []).map((x) => norm(x)).filter(Boolean);

// Would this negative (text, match) block a target, a protected/brand word or a search that converted?
export function guardNegative(neg, ctx = {}) {
  const [text, match] = Array.isArray(neg) ? neg : parseNeg(neg);
  if (!toks(text).length) return 'empty negative';
  if (toks(text).length > 10) return 'more than 10 words (Google limit)';
  const t = lc(ctx.targets).find((x) => blocks(text, match, x));
  if (t) return `would block target "${t}"`;
  const p = lc(ctx.protect).find((x) => blocks(text, match, x) || (match !== 'EXACT' && toks(text).some((w) => toks(x).includes(w))));
  if (p) return `would block protected word "${p}"`;
  const c = lc(ctx.converted).find((x) => blocks(text, match, x));
  if (c) return `would block a search that converted: "${c}"`;
  return null;
}

// Pick the narrowest negative: the broad word if it is safe, else the exact full search.
function pick(term, word, category, reason, ctx) {
  if (word) {
    const m = toks(word).length > 1 ? 'PHRASE' : 'BROAD';
    if (!guardNegative([word, m], ctx)) return { term, category, negative: fmtNeg(word, m), reason };
  }
  return { term, category, negative: fmtNeg(term, 'EXACT'), reason };
}

export function classifyTerm(raw, ctx = {}) {
  const term = norm(raw); if (!term) return null;
  const words = toks(term);
  const targets = lc(ctx.targets), protect = lc(ctx.protect);
  // Never touch a brand search or one of our own targets.
  if (protect.some((p) => has(term, p))) return null;
  if (targets.includes(term)) return null;
  const targeted = (w) => targets.some((t) => toks(t).includes(w));

  const comp = lc(ctx.competitors).find((c) => has(term, c));
  if (comp) return pick(term, comp, 'competitor', `searches for another company (${comp})`, ctx);
  const off = lc(ctx.offNiche).find((o) => has(term, o));
  if (off) return pick(term, off, 'off-niche', `the business does not offer "${off}"`, ctx);

  const job = words.find((w) => ALWAYS_BAD.jobs.includes(w) && !targeted(w));
  if (job) return pick(term, job, 'jobs', `job seeker search ("${job}")`, ctx);
  const bad = words.find((w) => ALWAYS_BAD.informational.includes(w) && !targeted(w));
  if (bad) return pick(term, bad, 'informational', `"${bad}" means research, not buying`, ctx);

  const ip = INFO_PHRASES.find((p) => has(term, p) && !targets.some((t) => has(t, p)));
  if (ip) return pick(term, null, 'informational', `learning search ("${ip}")`, ctx);
  const iw = words.find((w) => INFO_WORDS.includes(w) && !targeted(w));
  if (iw) return pick(term, null, 'informational', `learning search ("${iw}")`, ctx);

  // Other company, kept conservative: only clear signs (a web address, LLC/Inc, or "X login / customer service").
  const tokCo = words.find((w) => COMPANY_TOKENS.test(w));
  const phCo = COMPANY_PHRASES.find((p) => has(term, p));
  if ((tokCo || phCo) && !targets.some((t) => has(term, t))) return pick(term, null, 'competitor', `looks like a search for a specific other company ("${tokCo || phCo}")`, ctx);
  return null;
}

// Full pass over a list of search-term rows: [{term, conv, cost, ...}]. Returns { picks, refused, kept }.
export function classifyAll(rows, ctx = {}) {
  const picks = [], refused = [], kept = [];
  const converted = [...lc(ctx.converted), ...rows.filter((r) => Number(r.conv) > 0).map((r) => norm(r.term))];
  const c2 = { ...ctx, converted };
  for (const r of rows) {
    if (Number(r.conv) > 0) { kept.push({ ...r, why: 'converted' }); continue; }
    const p = classifyTerm(r.term, c2);
    if (!p) { kept.push(r); continue; }
    const why = guardNegative(p.negative, c2);
    if (why) refused.push({ ...p, refused: why }); else picks.push({ ...p, cost: r.cost, clicks: r.clk, campaign: r.campaign });
  }
  return { picks, refused, kept };
}
