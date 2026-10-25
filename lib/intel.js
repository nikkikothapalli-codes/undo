// Scam intelligence in Snowflake: how often a script has been reported, what it cost people,
// whether this recipient has been reported, and what Pause has stopped.
// Falls back to an in-memory copy of the same data when Snowflake isn't configured.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import snowflake from 'snowflake-sdk';
import { CATEGORY_LABEL } from './scam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(ROOT, 'keys');
const PRIV = path.join(KEY_DIR, 'snowflake_rsa.p8');
const PUB = path.join(KEY_DIR, 'snowflake_rsa.pub');

export const SF = { ok: false, error: 'not configured' };

export function snowflakeKeys() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  if (!fs.existsSync(PRIV)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.writeFileSync(PRIV, privateKey, { mode: 0o600 });
    fs.writeFileSync(PUB, publicKey);
  }
  const pub = fs.readFileSync(PUB, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return { privateKey: fs.readFileSync(PRIV, 'utf8'), publicKeyBody: pub };
}

// ---------- Seed data: 60 days of scam reports (synthetic, shaped like FTC/IC3 category mix) ----------
const MIX = [
  ['grandparent', 0.24, [800, 9000], ['Jake', 'Emily', 'Tyler', 'Sophie']],
  ['government', 0.18, [500, 15000], ['IRS Agent Miller', 'SSA Office', 'Officer Reyes']],
  ['tech_support', 0.17, [300, 25000], ['Microsoft Support', 'Apple Security', 'Amazon Fraud Dept']],
  ['gift_card', 0.13, [200, 3000], ['Store Manager', 'Utility Billing']],
  ['crypto', 0.12, [1000, 60000], ['Investment Advisor', 'Bitcoin Recovery']],
  ['romance', 0.09, [1000, 40000], ['Daniel (overseas)', 'Capt. Robert']],
  ['prize', 0.07, [100, 2500], ['Prize Center', 'Sweepstakes Office']],
];
export const REPORTS = [];
(() => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const now = Date.now();
  for (let i = 0; i < 900; i++) {
    let x = rnd(), pick = MIX[0];
    for (const m of MIX) { if (x < m[1]) { pick = m; break; } x -= m[1]; }
    const [cat, , [lo, hi], names] = pick;
    REPORTS.push({
      category: cat,
      lossUsd: rnd() < 0.35 ? 0 : Math.round(lo + (hi - lo) * rnd() * rnd()),
      recipient: names[Math.floor(rnd() * names.length)],
      daysAgo: Math.floor(rnd() * 60),
      at: new Date(now - Math.floor(rnd() * 60) * 86400000).toISOString().slice(0, 19).replace('T', ' '),
      state: ['TX', 'FL', 'CA', 'AZ', 'NY', 'OH', 'PA'][Math.floor(rnd() * 7)],
    });
  }
  for (const r of REPORTS) r.at = new Date(now - r.daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
})();
const OUTCOMES = [];

let conn = null;
function exec(sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (err, _s, rows) => (err ? reject(err) : resolve(rows || [])) });
  });
}

export async function initIntel() {
  const { SNOWFLAKE_ACCOUNT: account, SNOWFLAKE_USER: username } = process.env;
  if (!account || !username) return;
  try {
    snowflake.configure({ logLevel: 'ERROR' });
    const { privateKey } = snowflakeKeys();
    conn = snowflake.createConnection({
      account: account.trim().replace('.', '-'),
      username: username.trim(),
      authenticator: 'SNOWFLAKE_JWT',
      privateKey,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
      role: process.env.SNOWFLAKE_ROLE || 'ACCOUNTADMIN',
      timeout: 20000,
    });
    await new Promise((res, rej) => conn.connect((err) => (err ? rej(err) : res())));
    await exec('CREATE DATABASE IF NOT EXISTS PAUSE');
    await exec('USE DATABASE PAUSE');
    await exec('USE SCHEMA PUBLIC');
    await exec(`CREATE TABLE IF NOT EXISTS SCAM_REPORTS (CATEGORY STRING, RECIPIENT STRING, LOSS_USD NUMBER, STATE STRING, REPORTED_AT TIMESTAMP_NTZ)`);
    await exec(`CREATE TABLE IF NOT EXISTS PAUSE_OUTCOMES (TRANSFER_ID STRING, CATEGORY STRING, RISK_LEVEL STRING, RISK_SCORE NUMBER, AMOUNT_USD NUMBER, OUTCOME STRING, DECIDED_BY STRING, AT TIMESTAMP_NTZ, TX STRING)`);
    const [{ N }] = await exec('SELECT COUNT(*) AS N FROM SCAM_REPORTS');
    if (!Number(N)) {
      // Bulk insert in chunks.
      for (let i = 0; i < REPORTS.length; i += 150) {
        const chunk = REPORTS.slice(i, i + 150);
        await exec(`INSERT INTO SCAM_REPORTS VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}`,
          chunk.flatMap((r) => [r.category, r.recipient, r.lossUsd, r.state, r.at]));
      }
    }
    Object.assign(SF, { ok: true, error: null });
    console.log('[snowflake] connected, PAUSE.PUBLIC ready');
  } catch (e) {
    SF.error = e.message;
    console.log('[snowflake] offline:', e.message);
  }
}

// How common is this script, and has this recipient been reported?
export async function intelFor(category, payeeName) {
  const first = String(payeeName || '').split(/[\s(]/)[0];
  if (SF.ok) {
    try {
      const [r] = await exec(
        `SELECT COUNT_IF(REPORTED_AT >= DATEADD(day, -30, CURRENT_TIMESTAMP())) AS R30,
                SUM(IFF(REPORTED_AT >= DATEADD(day, -30, CURRENT_TIMESTAMP()), LOSS_USD, 0)) AS L30,
                COUNT_IF(RECIPIENT ILIKE ?) AS RECIP
         FROM SCAM_REPORTS WHERE CATEGORY = ?`, [`%${first}%`, category]);
      return { category, label: CATEGORY_LABEL[category], reports30d: Number(r.R30), lossesUsd30d: Number(r.L30), recipientReports: first ? Number(r.RECIP) : 0, source: 'Snowflake' };
    } catch (e) { console.log('[snowflake] intel query failed:', e.message); }
  }
  const rows = REPORTS.filter((r) => r.category === category);
  const recent = rows.filter((r) => r.daysAgo < 30);
  return {
    category, label: CATEGORY_LABEL[category],
    reports30d: recent.length,
    lossesUsd30d: recent.reduce((a, r) => a + r.lossUsd, 0),
    recipientReports: first ? rows.filter((r) => r.recipient.toLowerCase().includes(first.toLowerCase())).length : 0,
    source: 'local copy',
  };
}

export async function recordOutcome(o) {
  OUTCOMES.push(o);
  if (!SF.ok) return;
  try {
    await exec('INSERT INTO PAUSE_OUTCOMES VALUES (?,?,?,?,?,?,?,?,?)',
      [o.id, o.category, o.level, o.score, o.amountUsd, o.outcome, o.by, new Date(o.at).toISOString().slice(0, 19).replace('T', ' '), o.tx || null]);
  } catch (e) { console.log('[snowflake] outcome insert failed:', e.message); }
}

export async function globalIntel(heldUsd) {
  let tops, totals, out;
  if (SF.ok) {
    try {
      tops = await exec(`SELECT CATEGORY, COUNT(*) AS N FROM SCAM_REPORTS WHERE REPORTED_AT >= DATEADD(day, -30, CURRENT_TIMESTAMP()) GROUP BY CATEGORY ORDER BY N DESC LIMIT 4`);
      [totals] = await exec(`SELECT COUNT(*) AS N, SUM(LOSS_USD) AS L FROM SCAM_REPORTS WHERE REPORTED_AT >= DATEADD(day, -30, CURRENT_TIMESTAMP())`);
      [out] = await exec(`SELECT COUNT_IF(OUTCOME = 'cancelled') AS C, SUM(IFF(OUTCOME = 'cancelled', AMOUNT_USD, 0)) AS S FROM PAUSE_OUTCOMES`);
      return {
        reports30d: Number(totals.N), lossesUsd30d: Number(totals.L),
        topScripts: tops.map((t) => ({ category: t.CATEGORY, label: CATEGORY_LABEL[t.CATEGORY], reports30d: Number(t.N) })),
        cancelledCount: Number(out.C) || 0, savedUsd: Number(out.S) || 0, heldUsd, source: 'Snowflake',
      };
    } catch (e) { console.log('[snowflake] global intel failed:', e.message); }
  }
  const recent = REPORTS.filter((r) => r.daysAgo < 30);
  const counts = {};
  for (const r of recent) counts[r.category] = (counts[r.category] || 0) + 1;
  const cancelled = OUTCOMES.filter((o) => o.outcome === 'cancelled');
  return {
    reports30d: recent.length, lossesUsd30d: recent.reduce((a, r) => a + r.lossUsd, 0),
    topScripts: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => ({ category: c, label: CATEGORY_LABEL[c], reports30d: n })),
    cancelledCount: cancelled.length, savedUsd: cancelled.reduce((a, o) => a + o.amountUsd, 0), heldUsd, source: 'local copy',
  };
}
