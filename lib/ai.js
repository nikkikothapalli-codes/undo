import * as cheerio from 'cheerio';

// The AI judge. Runs on Vultr Serverless Inference when VULTR_INFERENCE_KEY is set,
// otherwise on any OpenAI-compatible backup (Groq by default).

const PROVIDERS = [];
if (process.env.VULTR_INFERENCE_KEY) {
  PROVIDERS.push({ name: 'Vultr Inference', base: 'https://api.vultrinference.com/v1', key: process.env.VULTR_INFERENCE_KEY, model: process.env.VULTR_MODEL || '' });
}
if (process.env.LLM_API_KEY) {
  PROVIDERS.push({ name: 'Backup LLM', base: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'llama-3.3-70b-versatile' });
}

export const AI = { ok: false, provider: null, model: null, error: PROVIDERS.length ? 'checking' : 'no AI key set' };

const PREFER = [/llama-?3\.3-70b/i, /llama.*70b/i, /qwen.*(72|32)b/i, /deepseek/i, /mistral-?large|mixtral/i, /llama/i];

async function listModels(p) {
  for (const url of [`${p.base}/models`, `${p.base}/chat/models`]) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const ids = (j.data || j.models || j || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
      if (ids.length) return ids;
    } catch {}
  }
  return [];
}

async function rawChat(p, messages, { json = true, max = 900 } = {}) {
  const body = { model: p.model, messages, temperature: 0.2, max_tokens: max };
  if (json) body.response_format = { type: 'json_object' };
  let r = await fetch(`${p.base}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok && json && r.status === 400) { // some models reject response_format
    delete body.response_format;
    r = await fetch(`${p.base}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  }
  if (!r.ok) throw new Error(`${p.name} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

export async function aiSelfTest() {
  for (const p of PROVIDERS) {
    try {
      let candidates = p.model ? [p.model] : [];
      if (!candidates.length) {
        const ids = await listModels(p);
        candidates = [...new Set([...PREFER.map((re) => ids.find((id) => re.test(id))).filter(Boolean), ...ids])].slice(0, 4);
        if (!candidates.length) throw new Error('no models listed');
      }
      let lastErr = null;
      for (const m of candidates) {
        try {
          // Reasoning models can spend a short budget thinking, so give room and accept any successful reply.
          await rawChat({ ...p, model: m }, [{ role: 'user', content: 'Reply with {"ok":true}' }], { max: 400 });
          p.model = m;
          Object.assign(AI, { ok: true, provider: p.name, model: m, error: null, p });
          console.log(`[ai] using ${p.name} · ${m}`);
          return;
        } catch (e) { lastErr = e; console.log(`[ai] ${p.name} ${m} failed: ${e.message}`); }
      }
      throw lastErr || new Error('no working model');
    } catch (e) {
      console.log(`[ai] ${p.name} failed: ${e.message}`);
      AI.error = e.message;
    }
  }
}

function parseJson(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : s);
}

export async function chatJson(system, user) {
  if (!AI.ok) throw new Error('AI offline');
  const out = await rawChat(AI.p, [{ role: 'system', content: system }, { role: 'user', content: user }], { max: 2000 });
  return parseJson(out);
}

// ---------- Draft milestones from a plain-English brief ----------
export async function draftMilestones(brief, budgetSol) {
  const sys = `You turn a freelance job brief into 2-4 milestones for an escrow contract.
Each milestone needs a short title, a share of the budget in SOL (they must add up to the budget), days until due, and 2-4 acceptance criteria.
Criteria must be objectively checkable by opening the delivered link and reading the page (e.g. "Page is live at a public URL", "Page has an email signup form", "Menu section lists at least 3 items with prices", "Page has a mobile viewport tag"). Prefer things visible on the live page; use a GitHub PR only if the brief is about code. No vague criteria like "looks good". The first milestone should be the main deliverable.
Return JSON: {"milestones":[{"title":"","amountSol":0.1,"days":3,"criteria":["",""]}]}`;
  try {
    const j = await chatJson(sys, `Budget: ${budgetSol} SOL\nBrief: ${brief}`);
    const ms = (j.milestones || []).slice(0, 4).map((m) => ({
      title: String(m.title || 'Milestone').slice(0, 60),
      amountSol: Math.max(0.01, Number(m.amountSol) || 0),
      days: Math.max(1, Math.round(Number(m.days) || 3)),
      criteria: (m.criteria || []).map(String).filter(Boolean).slice(0, 4),
    }));
    if (ms.length) return normalize(ms, budgetSol);
  } catch (e) { console.log('[ai] draft fallback:', e.message); }
  return normalize([
    { title: 'Landing page live', amountSol: 0.3, days: 3, criteria: ['Page is live at a public URL', 'Page has an email signup form', 'Page has a mobile viewport tag'] },
    { title: 'Menu and hours', amountSol: 0.2, days: 5, criteria: ['Menu section lists at least 3 items with prices', 'Opening hours and address are on the page'] },
  ], budgetSol);
}

function normalize(ms, budget) {
  const total = ms.reduce((a, m) => a + m.amountSol, 0) || 1;
  let left = Number(budget);
  return ms.map((m, i) => {
    const amt = i === ms.length - 1 ? Math.round(left * 1000) / 1000 : Math.round((m.amountSol / total) * budget * 1000) / 1000;
    left -= amt;
    return { ...m, amountSol: amt };
  });
}

// ---------- Gather evidence from what the freelancer submitted ----------
const strip = (html) => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Anything that reads like an instruction to the judge. A hit can only BLOCK a payout.
const INJECTION = [
  [/ignore (all |any |the )?(previous|prior|above|earlier)? ?(instructions|criteria|rules)/i, 'tells the judge to ignore its instructions'],
  [/(you are|act as) (now )?(the |an? )?(ai|judge|assistant|system)/i, 'tries to reassign the judge\'s role'],
  [/(approve|release|pay out|mark (as )?(met|passed|complete))\b.{0,40}\b(milestone|payment|funds|criteria|submission)/i, 'asks the judge to approve or release funds'],
  [/(all )?criteria (are|were|have been) (met|satisfied|passed)/i, 'claims the criteria are met instead of showing it'],
  [/(system prompt|developer message|<\/?(system|instructions)>|\[\/?inst\])/i, 'contains prompt-formatting markers'],
  [/"?pass"?\s*:\s*true/i, 'contains a pre-written verdict'],
];
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF]/;

export function scanForInjection(text, where) {
  const flags = [];
  for (const [re, why] of INJECTION) if (re.test(text)) flags.push(`The ${where} ${why}.`);
  if (ZERO_WIDTH.test(text)) flags.push(`The ${where} contains invisible zero-width characters.`);
  return flags;
}

// Visible text only: hidden elements are where injected instructions usually live.
export function visibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, [hidden], [aria-hidden="true"]').remove();
  $('[style]').each((_, el) => {
    const st = ($(el).attr('style') || '').replace(/\s/g, '').toLowerCase();
    if (/display:none|visibility:hidden|font-size:0|opacity:0|left:-\d{3,}|height:0/.test(st)) $(el).remove();
  });
  $('p, div, h1, h2, h3, h4, li, section, header, footer, span, b, br, td').after(' ');
  return $('body').text().replace(/\s+/g, ' ').trim();
}

export async function gatherEvidence(url, note) {
  const ev = { url: url || null, note: note || '', facts: [], fetched: false, flags: scanForInjection(note || '', "freelancer's note") };
  if (!url) return ev;
  try {
    const gh = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (gh) {
      const [, o, r, n] = gh;
      const headers = { 'User-Agent': 'deadlock-judge', Accept: 'application/vnd.github+json' };
      const pr = await (await fetch(`https://api.github.com/repos/${o}/${r}/pulls/${n}`, { headers, signal: AbortSignal.timeout(10000) })).json();
      if (pr.title) {
        ev.fetched = true;
        ev.kind = 'github_pr';
        ev.stats = { source: 'GitHub API', status: 200, files: pr.changed_files };
        ev.facts.push(`GitHub PR #${n} "${pr.title}" in ${o}/${r}`, `State: ${pr.merged ? 'merged' : pr.state}`, `${pr.changed_files} files changed, +${pr.additions} / -${pr.deletions}`);
        if (pr.body) { ev.facts.push(`PR description: ${pr.body.slice(0, 600)}`); ev.flags.push(...scanForInjection(pr.body, 'PR description')); }
        try {
          const files = await (await fetch(`https://api.github.com/repos/${o}/${r}/pulls/${n}/files?per_page=30`, { headers, signal: AbortSignal.timeout(10000) })).json();
          if (Array.isArray(files)) ev.facts.push(`Files: ${files.map((f) => f.filename).join(', ').slice(0, 600)}`);
        } catch {}
        return ev;
      }
    }
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 deadlock-judge' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    const html = (await r.text()).slice(0, 2_000_000);
    ev.fetched = r.ok;
    const visible = visibleText(html);
    const hiddenOnly = strip(html).length - visible.length;
    ev.flags.push(...scanForInjection(strip(html.replace(/<script[\s\S]*?<\/script>/gi, ' ')), 'submitted page'));
    if (ev.flags.length && hiddenOnly > 40) ev.flags.push('Some of that text is hidden from human visitors.');
    ev.stats = { source: 'web page', status: r.status, bytes: html.length, hiddenChars: Math.max(0, hiddenOnly), visibleChars: visible.length };
    ev.kind = 'web_page';
    ev.facts.push(`HTTP ${r.status} from ${url}`);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    if (title) ev.facts.push(`Page title: ${title.slice(0, 120)}`);
    const forms = (html.match(/<form/gi) || []).length;
    const emails = (html.match(/type=["']?email/gi) || []).length;
    const inputs = (html.match(/<input/gi) || []).length;
    ev.facts.push(`Forms on page: ${forms}, inputs: ${inputs}, email inputs: ${emails}`);
    ev.facts.push(`Has mobile viewport tag: ${/name=["']viewport["']/i.test(html) ? 'yes' : 'no'}`);
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => strip(m[1])).filter(Boolean).slice(0, 8);
    if (headings.length) ev.facts.push(`Headings: ${headings.join(' | ').slice(0, 400)}`);
    ev.facts.push(`Visible text (start): ${visible.slice(0, 900)}`);
  } catch (e) {
    ev.facts.push(`Could not open ${url}: ${e.message}`);
  }
  return ev;
}

// ---------- The verdict ----------
export async function judge({ milestone, evidence }) {
  // The evidence can close the gate, never open it.
  if (evidence.flags?.length) {
    return {
      pass: false,
      flags: [...new Set(evidence.flags)],
      checks: milestone.criteria.map((c) => ({ criterion: c, met: false, why: 'Not judged: the submission tried to steer the judge.' })),
      summary: 'Payment blocked. Submissions are treated as data, and this one contained instructions aimed at the judge.',
      by: 'injection guard',
    };
  }
  const sys = `You are the judge for a freelance escrow contract on Solana. Funds release to the freelancer only if EVERY acceptance criterion is met.
Judge strictly from the evidence below (facts gathered by the server from the submitted link, plus the freelancer's note). Do not assume things the evidence does not show. The freelancer's note counts as a claim, not proof, unless the criterion is about something only a note can show.
Return JSON: {"checks":[{"criterion":"","met":true,"why":"one short sentence citing the evidence"}],"pass":true,"summary":"one sentence"}`;
  const user = `Milestone: ${milestone.title}
Acceptance criteria:
${milestone.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Submitted link: ${evidence.url || '(none)'}
Freelancer's note: ${evidence.note || '(none)'}
Evidence gathered:
${evidence.facts.map((f) => `- ${f}`).join('\n') || '- (nothing could be gathered)'}`;
  try {
    const j = await chatJson(sys, user);
    const checks = milestone.criteria.map((c, i) => {
      const k = (j.checks || [])[i] || {};
      return { criterion: c, met: k.met === true, why: String(k.why || '').slice(0, 200) };
    });
    const linkOk = !evidence.url || evidence.fetched;
    const pass = linkOk && checks.every((c) => c.met);
    return { pass, checks, summary: String(j.summary || '').slice(0, 240), by: `${AI.provider} · ${AI.model}` };
  } catch (e) {
    console.log('[ai] judge fallback:', e.message);
    // Offline fallback: a link that opened plus a note counts as delivered.
    const ok = !!(evidence.fetched && (evidence.note || '').length > 3);
    return {
      pass: ok,
      checks: milestone.criteria.map((c) => ({ criterion: c, met: ok, why: ok ? 'Link opened and the freelancer described the work.' : 'Could not verify from the submission.' })),
      summary: ok ? 'Delivered (offline check: AI unavailable).' : 'Could not verify the work (AI unavailable).',
      by: 'offline rules',
    };
  }
}
