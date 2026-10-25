// Solana side of Deadlock: wallets, the escrow program's instructions, balances.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = path.join(ROOT, 'keys');
export const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
export const conn = new Connection(RPC, 'confirmed');

function programIdFromDisk() {
  for (const f of [path.join(ROOT, 'program', 'program-id.txt'), path.join(KEYS, 'program-id.txt')]) {
    try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {}
  }
  return '';
}
export const PROGRAM_ID_STR = (process.env.PROGRAM_ID || programIdFromDisk()).trim();
export const PROGRAM_ID = PROGRAM_ID_STR ? new PublicKey(PROGRAM_ID_STR) : (process.env.DEADLOCK_MOCK === '1' ? PublicKey.default : null);

function loadOrCreate(name) {
  fs.mkdirSync(KEYS, { recursive: true });
  const f = path.join(KEYS, `${name}.json`);
  if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}
function loadDeployer() {
  try {
    const f = path.join(os.homedir(), '.config', 'solana', 'id.json');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
  } catch { return null; }
}

// Demo wallets live on the server so the demo never depends on a browser extension.
export const wallets = {
  client: loadOrCreate('client'),
  freelancer: loadOrCreate('freelancer'),
  judge: loadOrCreate('judge'),
  attacker: loadOrCreate('attacker'),
};
const deployer = loadDeployer();

export const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
export const sol = (lamports) => Math.round((lamports / LAMPORTS_PER_SOL) * 10000) / 10000;
export const lamports = (s) => Math.round(Number(s) * LAMPORTS_PER_SOL);

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

export function dealPda(client, chainId) {
  return PublicKey.findProgramAddressSync([Buffer.from('deal'), client.toBuffer(), u64(chainId)], PROGRAM_ID)[0];
}

async function send(ix, signer) {
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });
}

function lockIx({ chainId, amountSol, deadline }) {
  const client = wallets.client;
  const pda = dealPda(client.publicKey, chainId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: client.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallets.freelancer.publicKey, isSigner: false, isWritable: false },
      { pubkey: wallets.judge.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0]), u64(chainId), u64(lamports(amountSol)), i64(deadline)]),
  });
}

// Lock every milestone of a deal in ONE transaction (one signature from the client).
export async function lockMany(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.lockMany(...a); return _lockMany(...a); }
async function _lockMany(items) {
  const tx = new Transaction();
  for (const it of items) tx.add(lockIx(it));
  const sig = await sendAndConfirmTransaction(conn, tx, [wallets.client], { commitment: 'confirmed' });
  return { sig, pdas: items.map((it) => dealPda(wallets.client.publicKey, it.chainId).toBase58()) };
}

// by: 'client' | 'judge'
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export async function release(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.release(...a); return _release(...a); }
async function _release({ chainId, by, memo }) {
  const signer = wallets[by];
  const pda = dealPda(wallets.client.publicKey, chainId);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallets.freelancer.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1]),
  });
  if (memo) {
    const tx = new Transaction().add(ix).add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') }));
    return sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });
  }
  return send(ix, signer);
}

export async function refund(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.refund(...a); return _refund(...a); }
async function _refund({ chainId, by, memo }) {
  const signer = wallets[by];
  const pda = dealPda(wallets.client.publicKey, chainId);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallets.client.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([2]),
  });
  if (memo) {
    const tx = new Transaction().add(ix).add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') }));
    return sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });
  }
  return send(ix, signer);
}

// Read a deal account straight from the chain (the source of truth for the vault).
export async function readDeal(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.readDeal(...a); return _readDeal(...a); }
async function _readDeal(chainId) {
  const pda = dealPda(wallets.client.publicKey, chainId);
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  const d = info.data;
  const states = { 1: 'locked', 2: 'released', 3: 'refunded' };
  return {
    pda: pda.toBase58(),
    lamports: info.lamports,
    state: states[d[0]] || 'unknown',
    amount: sol(Number(d.readBigUInt64LE(97))),
    deadline: Number(d.readBigInt64LE(105)),
  };
}

export async function balances(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.balances(...a); return _balances(...a); }
async function _balances() {
  const out = {};
  for (const [k, kp] of Object.entries(wallets)) {
    let bal = null;
    try { bal = sol(await conn.getBalance(kp.publicKey)); } catch {}
    out[k] = { address: kp.publicKey.toBase58(), sol: bal, url: explorer('address', kp.publicKey.toBase58()) };
  }
  return out;
}

export async function programStatus(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.programStatus(...a); return _programStatus(...a); }
async function _programStatus() {
  if (!PROGRAM_ID) return { deployed: false, reason: 'no program id yet (run deploy/solana.sh)' };
  try {
    const info = await conn.getAccountInfo(PROGRAM_ID);
    return { deployed: !!info?.executable, id: PROGRAM_ID_STR, url: explorer('address', PROGRAM_ID_STR) };
  } catch (e) { return { deployed: false, id: PROGRAM_ID_STR, reason: e.message }; }
}

// Keep the demo wallets topped up from the deployer wallet (or the devnet faucet).
export async function topUp(...a) { if (globalThis.__deadlockMock) return globalThis.__deadlockMock.topUp(...a); return _topUp(...a); }
async function _topUp() {
  const want = { client: 1, judge: 0.05, attacker: 0.02, freelancer: 0.02 };
  for (const [k, min] of Object.entries(want)) {
    const kp = wallets[k];
    try {
      const bal = await conn.getBalance(kp.publicKey);
      if (bal >= lamports(min) * 0.5) continue;
      const need = lamports(min) - bal;
      // Fund from the deployer if there is one, otherwise the client wallet pays for the judge/attacker fees.
      const funder = deployer || (k !== 'client' ? wallets.client : null);
      if (funder && (await conn.getBalance(funder.publicKey)) > need + lamports(0.05)) {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: need }));
        await sendAndConfirmTransaction(conn, tx, [funder]);
        console.log(`[chain] topped up ${k} with ${sol(need)} SOL`);
      } else {
        const sig = await conn.requestAirdrop(kp.publicKey, Math.min(need, lamports(1)));
        await conn.confirmTransaction(sig, 'confirmed');
        console.log(`[chain] airdropped to ${k}`);
      }
    } catch (e) {
      console.log(`[chain] could not top up ${k} (${kp.publicKey.toBase58()}): ${e.message}. Fund it at https://faucet.solana.com`);
    }
  }
}

// Read the memo (the verdict receipt) back out of a confirmed transaction.
export async function readMemo(sig) {
  if (globalThis.__deadlockMock) return globalThis.__deadlockMock.memos?.get(sig) || null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const line = (j.result?.meta?.logMessages || []).find((l) => l.includes('pause:receipt:'));
      const m = line && line.match(/pause:receipt:([0-9a-f]{64})/);
      if (m) return m[1];
    } catch (e) { console.log('[chain] readMemo:', e.message); }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

// ---------- Attacks (for the demo) ----------
// Each one is sent for real with preflight off, so the failed transaction lands on-chain
// and shows up on Solana Explorer as rejected by the escrow program.
async function sendRejected(ix, signer) {
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await conn.confirmTransaction(sig, 'confirmed');
  let logs = [];
  try { logs = (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages || []; } catch {}
  return { sig, failed: !!res.value.err, err: res.value.err, logs };
}

export async function attack(kind, { chainId }) {
  if (globalThis.__deadlockMock) return globalThis.__deadlockMock.attack(kind, { chainId });
  const pda = dealPda(wallets.client.publicKey, chainId);
  const A = wallets.attacker;
  let ix, signer, reason;
  if (kind === 'scammer') {
    // The payee (the scammer) tries to pull the money out himself.
    signer = wallets.freelancer; reason = 'only Grandma (after the hold) or her family can release it';
    ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.from([1]), keys: [
      { pubkey: wallets.freelancer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallets.freelancer.publicKey, isSigner: false, isWritable: true }] });
  } else if (kind === 'redirect') {
    // Someone with the family key tries to send it to a different wallet.
    signer = wallets.judge; reason = 'the money can only go to the original payee or back to Grandma';
    ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.from([1]), keys: [
      { pubkey: wallets.judge.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: A.publicKey, isSigner: false, isWritable: true }] });
  } else {
    // The scammer pressures Grandma into pressing "send now" before the hold ends.
    signer = wallets.client; reason = "the hold isn't over yet, so nobody can rush it";
    ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.from([1]), keys: [
      { pubkey: wallets.client.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallets.freelancer.publicKey, isSigner: false, isWritable: true }] });
  }
  const r = await sendRejected(ix, signer);
  return { rejected: r.failed, reason, sig: r.sig, url: explorer('tx', r.sig), logs: r.logs.filter((l) => /pause|failed|error/i.test(l)).slice(0, 4) };
}

// Turn a Solana error into something a human can read in the UI.
export function chainError(e) {
  const logs = (e?.logs || e?.transactionLogs || []).join('\n');
  const msg = String(e?.message || e);
  if (/hold not over/.test(logs) || /custom program error: 0x2\b/.test(msg)) {
    return "The vault program rejected this: the hold isn't over yet. Nobody can rush it.";
  }
  if (/insufficient lamports|Attempt to debit an account but found no record/i.test(msg + logs)) {
    return "The senior's demo wallet is out of devnet SOL. Top it up at faucet.solana.com.";
  }
  if (/already settled/.test(logs + msg)) return 'This transfer is already settled on-chain.';
  return msg.slice(0, 240);
}

// ---------- Local test mode (DEADLOCK_MOCK=1) ----------
// Only for developing the UI without network access. Applies the same rules as the program.
if (process.env.DEADLOCK_MOCK === '1') {
  const vaults = new Map();
  const fakeSig = () => Array.from({ length: 64 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');
  const now = () => Math.floor(Date.now() / 1000);
  const mock = {
    lockMany: async (items) => { await new Promise((r) => setTimeout(r, 700)); items.forEach((it) => vaults.set(it.chainId, { state: 'locked', amount: it.amountSol, deadline: it.deadline })); return { sig: fakeSig(), pdas: items.map(() => fakeSig().slice(0, 44)) }; },
    memos: new Map(),
    release: async ({ chainId, memo, by }) => { const v = vaults.get(chainId); if (v.state !== 'locked') throw new Error('already settled'); if (by === 'client' && now() < v.deadline) throw Object.assign(new Error('custom program error: 0x2'), { logs: ['pause: hold not over'] }); v.state = 'released'; const sg = fakeSig(); const h = memo && memo.match(/([0-9a-f]{64})/); if (h) mock.memos.set(sg, h[1]); return sg; },
    refund: async ({ chainId, memo }) => { const v = vaults.get(chainId); if (v.state !== 'locked') throw new Error('already settled'); v.state = 'refunded'; const sg = fakeSig(); const h = memo && memo.match(/([0-9a-f]{64})/); if (h) mock.memos.set(sg, h[1]); return sg; },
    readDeal: async (chainId) => { const v = vaults.get(chainId); return v ? { pda: 'mock', lamports: 0, ...v } : null; },
    attack: async (kind, { chainId }) => { const v = vaults.get(chainId); const sig = fakeSig(); const reason = { scammer: 'only Grandma (after the hold) or her family can release it', redirect: 'the money can only go to the original payee or back to Grandma', rush: "the hold isn't over yet, so nobody can rush it" }[kind]; const rejected = kind !== 'rush' || now() < v.deadline; if (!rejected) v.state = 'released'; return { rejected, reason, sig, url: explorer('tx', sig), logs: [] }; },
    balances: async () => Object.fromEntries(Object.entries(wallets).map(([k, kp]) => [k, { address: kp.publicKey.toBase58(), sol: k === 'client' ? 4.2 : 0.1, url: explorer('address', kp.publicKey.toBase58()) }])),
    programStatus: async () => ({ deployed: true, id: 'MOCKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', url: '#' }),
    topUp: async () => {},
  };
  globalThis.__deadlockMock = mock;
}
