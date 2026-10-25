// Pause: a cooling-off vault that stands between seniors and scammers.
// Solana holds the money · Vultr runs the scam check · Snowflake knows the scripts · Twilio texts the family.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import * as chain from './lib/chain.js';
import { AI, aiSelfTest } from './lib/ai.js';
import { sanitize, findFlags, explain, CATEGORY_LABEL } from './lib/scam.js';
import { SF, initIntel, intelFor, recordOutcome, globalIntel, snowflakeKeys } from './lib/intel.js';
import { SMS, textFamily } from './lib/notify.js';

const BUILD = 'pause-3';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'transfers.json');
fs.mkdirSync(DATA, { recursive: true });

const USD_PER_SOL = Number(process.env.DEMO_USD_PER_SOL) || 10000; // demo rate: $2,000 = 0.2 devnet SOL
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost').replace(/\/$/, '');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// client key = the senior, judge key = the family guardian, freelancer key = the payee.
const PEOPLE = {
  senior: { name: process.env.SENIOR_NAME || 'Rose Alvarez', wallet: chain.wallets.client.publicKey.toBase58() },
  family: { name: process.env.FAMILY_NAME || 'Maya Alvarez', wallet: chain.wallets.judge.publicKey.toBase58() },
  payee: { wallet: chain.wallets.freelancer.publicKey.toBase58() },
};

// Trusted contact on file (who gets the alert). Editable from Grandma's settings.
const CONTACT_FILE = path.join(DATA, 'contact.json');
let contact = { name: PEOPLE.family.name, relation: 'Granddaughter', phone: (process.env.FAMILY_PHONE || '').trim() };
try { contact = { ...contact, ...JSON.parse(fs.readFileSync(CONTACT_FILE, 'utf8')) }; } catch {}
PEOPLE.family.name = contact.name;
const maskPhone = (p) => (p ? `(•••) •••-${p.slice(-4)}` : 'not set');

let transfers = [];
try { transfers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(transfers, null, 1), () => {}), 150); };
const find = (id) => transfers.find((t) => t.id === id);
const shortId = () => Math.random().toString(36).slice(2, 8);
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const LIVE = ['held'];

function log(t, who, text, extra = {}) { t.events.unshift({ at: Date.now(), who, text, ...extra }); save(); }
function addTx(t, kind, sig) { t.txs.push({ kind, sig, url: chain.explorer('tx', sig), at: Date.now() }); }

// ---------------- Status & intel ----------------
let balCache = { at: 0, v: null };
app.get('/api/status', async (_req, res) => {
  if (Date.now() - balCache.at > 8000) balCache = { at: Date.now(), v: await chain.balances() };
  const b = balCache.v || {};
  res.json({
    build: BUILD,
    program: await chain.programStatus(),
    wallets: { senior: b.client, family: b.judge, payee: b.freelancer, attacker: b.attacker },
    people: { senior: PEOPLE.senior, family: PEOPLE.family },
    contact: { name: contact.name, relation: contact.relation, phone: maskPhone(contact.phone) },
    ai: { ok: AI.ok, provider: AI.provider, model: AI.model, error: AI.error },
    snowflake: { ok: SF.ok, error: SF.error },
    sms: { configured: SMS.configured },
    usdPerSol: USD_PER_SOL,
  });
});

app.get('/api/contact', (_req, res) => res.json({ name: contact.name, relation: contact.relation, phone: contact.phone, masked: maskPhone(contact.phone) }));
app.post('/api/contact', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const relation = String(req.body.relation || '').trim().slice(0, 40);
  let phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
  if (phone && !phone.startsWith('+')) phone = phone.length === 10 ? `+1${phone}` : `+${phone}`;
  if (!name) return res.status(400).json({ error: 'Add a name.' });
  if (!/^\+\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a full phone number, like (732) 555-0123.' });
  contact = { name, relation, phone };
  PEOPLE.family.name = name;
  fs.writeFileSync(CONTACT_FILE, JSON.stringify(contact));
  res.json({ name, relation, phone, masked: maskPhone(phone) });
});

app.get('/api/intel', async (_req, res) => {
  const heldUsd = transfers.filter((t) => t.state === 'held').reduce((a, t) => a + t.amountUsd, 0);
  res.json(await globalIntel(heldUsd));
});

// ---------------- Transfers ----------------
const summary = (t) => ({ id: t.id, createdAt: t.createdAt, payee: { name: t.payee.name }, amountUsd: t.amountUsd, state: t.state, risk: { level: t.risk?.level, score: t.risk?.score }, flagsCount: t.risk?.flags?.length || 0, releaseAt: t.releaseAt });
app.get('/api/transfers', (_req, res) => res.json(transfers.map(summary)));
app.get('/api/transfers/:id', (req, res) => {
  const t = find(req.params.id);
  return t ? res.json(t) : res.status(404).json({ error: 'not found' });
});

app.post('/api/transfers', (req, res) => {
  const b = req.body || {};
  const amountUsd = Math.round(Number(b.amountUsd));
  if (!(amountUsd >= 1)) return res.status(400).json({ error: 'Enter an amount in dollars.' });
  if (amountUsd > 15000) return res.status(400).json({ error: 'The demo wallet holds up to $15,000.' });
  if (!chain.PROGRAM_ID) return res.status(400).json({ error: 'The vault program is not deployed yet.' });
  const t = {
    id: shortId(),
    chainId: Date.now() * 10,
    createdAt: Date.now(),
    senior: PEOPLE.senior,
    family: { ...PEOPLE.family, relation: contact.relation, phone: maskPhone(contact.phone) },
    payee: { name: String(b.payeeName || 'Someone').slice(0, 60), wallet: PEOPLE.payee.wallet },
    amountUsd,
    amountSol: Math.round((amountUsd / USD_PER_SOL) * 10000) / 10000,
    message: String(b.message || '').slice(0, 2000),
    demoHold: !!b.demoHold,
    state: 'scanning',
    risk: null, intel: null, sms: null,
    holdSeconds: null, releaseAt: null,
    vault: null, vaultUrl: null,
    txs: [], pipeline: [], pipelineMs: null, receipt: null,
    events: [],
  };
  log(t, 'senior', `${t.senior.name.split(' ')[0]} started sending ${money(amountUsd)} to ${t.payee.name}`);
  transfers.unshift(t);
  save();
  runPipeline(t);
  res.json(t);
});

// The protection pipeline. Every step is timed and shown live in the app.
async function runPipeline(t) {
  const t0 = Date.now();
  const step = async (key, label, fn) => {
    const s = { key, label, state: 'running', detail: '' };
    t.pipeline.push(s);
    save();
    const start = Date.now();
    try {
      const out = await fn(s);
      if (s.state === 'running') s.state = 'done';
      return out;
    } catch (e) {
      s.state = 'failed';
      s.detail = chain.chainError(e);
      throw e;
    } finally {
      s.ms = Date.now() - start;
      if (s.ms < 380) await new Promise((r) => setTimeout(r, 380 - s.ms)); // readable during a live demo
      save();
    }
  };
  try {
    const clean = await step('read', 'Read the message that asked for money', async (s) => {
      const c = sanitize(t.message);
      s.detail = t.message ? `${c.text.length} characters · ${c.invisible} hidden characters removed` : 'no message pasted';
      return c;
    });
    await step('guard', 'Check for tricks aimed at the AI', async (s) => {
      s.detail = clean.steering ? 'found instructions aimed at the AI · treated as a red flag' : 'none found · message treated as untrusted data';
      if (clean.steering) s.state = 'blocked';
    });
    const found = await step('patterns', 'Scan for known scam patterns', async (s) => {
      const f = findFlags(clean.text, { amountUsd: t.amountUsd, steering: clean.steering, invisible: clean.invisible });
      s.detail = f.flags.length ? `${f.flags.length} red flag${f.flags.length > 1 ? 's' : ''} · risk ${f.score}/100` : 'no known patterns';
      if (f.level !== 'low') s.state = 'blocked';
      return f;
    });
    t.intel = await step('intel', 'Check scam reports in Snowflake', async (s) => {
      const i = await intelFor(found.category, t.payee.name);
      s.detail = found.flags.length ? `${i.label}: reported ${i.reports30d} times in 30 days · ${money(i.lossesUsd30d)} lost` : `${i.reports30d} reports in this category`;
      return i;
    });
    const ex = await step('ai', 'Explain it in plain English', async (s) => {
      const e = await explain({ text: clean.text, flags: found.flags, level: found.level, category: found.category, amountUsd: t.amountUsd, payeeName: t.payee.name, seniorName: t.senior.name, familyName: t.family.name });
      s.detail = e.by === 'rules' ? 'written from the rules (AI offline)' : `written by ${e.by}`;
      return e;
    });
    t.risk = {
      level: ex.level, score: found.score, category: found.category,
      flags: [...found.flags, ...(ex.extraFlags || [])].map(({ code, label, quote }) => ({ code, label, quote })),
      explanation: ex.explanation, familyNote: ex.familyNote, by: ex.by,
    };
    t.holdSeconds = t.demoHold ? 90 : t.risk.level === 'low' ? 3600 : 86400;
    t.releaseAt = Math.floor(Date.now() / 1000) + t.holdSeconds;
    const sig = await step('hold', 'Hold the money in a Solana vault', async (s) => {
      const r = await chain.lockMany([{ chainId: t.chainId, amountSol: t.amountSol, deadline: t.releaseAt }]);
      t.vault = r.pdas[0];
      t.vaultUrl = chain.explorer('address', t.vault);
      s.detail = `${money(t.amountUsd)} held until ${holdWords(t.holdSeconds)} from now · tx ${r.sig.slice(0, 8)}…`;
      return r.sig;
    });
    addTx(t, 'hold', sig);
    t.state = 'held';
    log(t, 'chain', `${money(t.amountUsd)} is held safely in a vault. It can't leave for ${holdWords(t.holdSeconds)}.`, { url: chain.explorer('tx', sig) });
    t.sms = await step('alert', `Text ${t.family.name.split(' ')[0]}`, async (s) => {
      const flagsWord = t.risk.flags.length ? `${t.risk.flags.length} scam red flag${t.risk.flags.length > 1 ? 's' : ''}` : 'no red flags';
      const body = `Undo: ${t.senior.name.split(' ')[0]} is trying to send ${money(t.amountUsd)} to "${t.payee.name}". ${flagsWord} (${t.risk.level} risk). It's held for ${holdWords(t.holdSeconds)}. Review or cancel: ${PUBLIC_URL}/#/t/${t.id}?as=family`;
      const r = await textFamily(body, contact.phone);
      s.detail = r.sent ? `text sent to ${r.to} via Twilio${r.template ? ' (trial alert template)' : ''}` : 'shown in the app (texting not set up)';
      return r;
    });
    log(t, 'family', t.sms.sent ? `${t.family.name.split(' ')[0]} got a text about it` : `${t.family.name.split(' ')[0]} was alerted in the app`);
  } catch (e) {
    t.state = t.vault ? 'held' : 'failed';
    log(t, 'ai', `Something went wrong: ${chain.chainError(e)}`);
  }
  t.pipelineMs = Date.now() - t0;
  save();
}

function holdWords(sec) {
  if (sec < 120) return `${sec} seconds`;
  if (sec < 7200) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec / 3600)} hours`;
}

// A decision receipt: SHA-256 over what the scan found and who decided. It rides in the
// settling transaction's memo, so anyone can check why the money moved.
function makeReceipt(t, decision, by) {
  const payload = {
    v: 1, transfer: t.id, vaultId: String(t.chainId), amountUsd: t.amountUsd,
    risk: { level: t.risk?.level, score: t.risk?.score, flags: (t.risk?.flags || []).map((f) => f.code) },
    explanationSha256: crypto.createHash('sha256').update(t.risk?.explanation || '').digest('hex'),
    decision, by,
  };
  return { hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload };
}

const busy = new Set();
async function guarded(res, key, fn) {
  if (busy.has(key)) return res.status(409).json({ error: 'already working on this' });
  busy.add(key);
  try { res.json(await fn()); } catch (e) {
    console.log('[transfer]', e.message);
    res.status(400).json({ error: chain.chainError(e) });
  } finally { busy.delete(key); }
}
function getT(req) {
  const t = find(req.params.id);
  if (!t) throw new Error('transfer not found');
  return t;
}
const roleKey = (by) => (by === 'family' ? 'judge' : 'client');
const who = (t, by) => (by === 'family' ? t.family.name.split(' ')[0] : t.senior.name.split(' ')[0]);

function settle(t, outcome, sig, kind, receipt, by) {
  t.state = outcome;
  addTx(t, kind, sig);
  t.receipt = { ...receipt, sig };
  recordOutcome({ id: t.id, category: t.risk?.category || 'other', level: t.risk?.level, score: t.risk?.score || 0, amountUsd: t.amountUsd, outcome, by, at: Date.now(), tx: sig });
  save();
}

app.post('/api/transfers/:id/cancel', (req, res) => guarded(res, req.params.id, async () => {
  const t = getT(req);
  if (!LIVE.includes(t.state)) throw new Error(`this transfer is already ${t.state}`);
  const by = req.body.by === 'family' ? 'family' : 'senior';
  const receipt = makeReceipt(t, 'cancelled', by);
  const sig = await chain.refund({ chainId: t.chainId, by: roleKey(by), memo: `pause:receipt:${receipt.hash}` });
  settle(t, 'cancelled', sig, 'cancel', receipt, by);
  log(t, by, `${who(t, by)} cancelled it. ${money(t.amountUsd)} went back to ${t.senior.name.split(' ')[0]}.`, { url: chain.explorer('tx', sig) });
  return t;
}));

app.post('/api/transfers/:id/release', (req, res) => guarded(res, req.params.id, async () => {
  const t = getT(req);
  if (!LIVE.includes(t.state)) throw new Error(`this transfer is already ${t.state}`);
  const by = req.body.by === 'family' ? 'family' : 'senior';
  const receipt = makeReceipt(t, 'released', by);
  try {
    const sig = await chain.release({ chainId: t.chainId, by: roleKey(by), memo: `pause:receipt:${receipt.hash}` });
    settle(t, 'released', sig, 'release', receipt, by);
    log(t, by, by === 'family' ? `${who(t, by)} confirmed it's legit. ${money(t.amountUsd)} sent to ${t.payee.name}.` : `Hold finished. ${money(t.amountUsd)} sent to ${t.payee.name}.`, { url: chain.explorer('tx', sig) });
  } catch (e) {
    const msg = chain.chainError(e);
    log(t, 'chain', `Tried to send early. ${msg}`);
    throw Object.assign(new Error(msg), { logs: e.logs });
  }
  return t;
}));

app.post('/api/transfers/:id/attack', (req, res) => guarded(res, req.params.id, async () => {
  const t = getT(req);
  if (!LIVE.includes(t.state)) throw new Error('attacks only work while the money is held');
  const kind = ['scammer', 'rush', 'redirect'].includes(req.body.kind) ? req.body.kind : 'scammer';
  const r = await chain.attack(kind, t);
  addTx(t, 'attack', r.sig);
  const label = { scammer: `${t.payee.name} tried to pull the money out himself`, rush: `The scammer pressured ${t.senior.name.split(' ')[0]} into sending it early`, redirect: 'Someone tried to send it to a different wallet' }[kind];
  if (kind === 'rush' && !r.rejected) {
    t.state = 'released';
    log(t, 'chain', 'Hold had finished, so the payment went through.', { url: r.url });
  } else {
    log(t, 'attack', `${label}. ${r.rejected ? `Rejected on-chain: ${r.reason}.` : 'It went through.'}`, { url: r.url });
  }
  save();
  return r;
}));

app.get('/api/transfers/:id/receipt', async (req, res) => {
  try {
    const t = getT(req);
    if (!t.receipt?.sig) return res.status(404).json({ error: 'no receipt yet' });
    const recomputed = crypto.createHash('sha256').update(JSON.stringify(t.receipt.payload)).digest('hex');
    const onchain = await chain.readMemo(t.receipt.sig);
    res.json({ match: !!onchain && onchain === recomputed, recomputed, onchain, sig: t.receipt.sig, rpc: chain.RPC, tx: chain.explorer('tx', t.receipt.sig), payload: t.receipt.payload });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/transfers/:id/vault', async (req, res) => {
  try {
    const t = getT(req);
    const v = await chain.readDeal(t.chainId);
    res.json(v ? { ...v, amountUsd: Math.round(v.amount * USD_PER_SOL) } : { state: 'not on chain' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/reset', (_req, res) => { transfers = []; save(); res.json({ ok: true }); });

app.get('/api/setup', (_req, res) => {
  const { publicKeyBody } = snowflakeKeys();
  const user = (process.env.SNOWFLAKE_USER || 'YOUR_USERNAME').toUpperCase();
  res.json({ snowflakeSql: `ALTER USER ${user} SET RSA_PUBLIC_KEY='${publicKeyBody}';`, snowflakeConfigured: !!(process.env.SNOWFLAKE_ACCOUNT && process.env.SNOWFLAKE_USER) });
});

app.get('/pitch', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'pitch.html')));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Pause ${BUILD} on http://localhost:${PORT}`);
  console.log(`[chain] program ${chain.PROGRAM_ID_STR || '(not deployed)'} · senior ${PEOPLE.senior.wallet}`);
  aiSelfTest();
  initIntel();
  chain.topUp();
  setInterval(() => chain.topUp(), 60 * 1000);
});
