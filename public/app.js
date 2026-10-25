// Pause web app. Routes: #/ send money (Rose) or overview (family), #/payments, #/contact, #/t/:id.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${(Math.round(Number(n) || 0)).toLocaleString('en-US')}`;
const usd2 = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const first = (name) => String(name || '').split(' ')[0];
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const stamp = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOf = (unix) => new Date(unix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

let role = 'senior';
try { role = localStorage.getItem('pause-role') || 'senior'; } catch {}
let STATUS = null;
let timer = null;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 3500);
}
async function act(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${btn.dataset.busy || 'One moment'}`;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

const EXAMPLE = {
  payeeName: 'Jake (new number)',
  amountUsd: 2000,
  message: "Grandma its Jake, I lost my phone so this is my new number. I got in a car accident and Im in jail, I need $2000 for bail right now. Please dont tell mom. You can pay with gift cards from Target.",
};
const IC = {
  pay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13"/></svg>',
  stop: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M5 15 15 5"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4 2.5 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H8"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h11M9 4l4 4-4 4"/></svg>',
};

// ---------- role + nav ----------
function setRole(r) {
  role = r === 'family' ? 'family' : 'senior';
  try { localStorage.setItem('pause-role', role); } catch {}
  document.querySelectorAll('.role button').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
}
document.querySelectorAll('.role button').forEach((b) => b.addEventListener('click', () => { setRole(b.dataset.role); location.hash = '#/'; route(); }));
setRole(role);

function paintNav() {
  const h = (location.hash || '#/').split('?')[0];
  const links = role === 'family'
    ? [['#/', 'Overview'], ['#/payments', 'Payments']]
    : [['#/', 'Send money'], ['#/payments', 'Payments'], ['#/contact', 'Trusted contact']];
  const cur = h.startsWith('#/t/') ? '#/payments' : h;
  $('#nav').innerHTML = links.map(([href, label]) => `<a href="${href}" class="${cur === href ? 'on' : ''}">${label}</a>`).join('');
  const [a, b] = document.querySelectorAll('.role button');
  if (a) a.textContent = first(STATUS?.people?.senior?.name || 'Rose');
  if (b) b.textContent = STATUS?.contact?.name ? first(STATUS.contact.name) : 'Family';
  $('#acctName').textContent = role === 'family' ? `Signed in as ${STATUS?.contact?.name || 'family'}` : `Signed in as ${STATUS?.people?.senior?.name || 'Rose'}`;
}

async function loadStatus() {
  try {
    STATUS = await api('/api/status');
    const s = STATUS;
    $('#status').innerHTML = [
      s.program.deployed ? `<span class="on">Vault program <a href="${s.program.url}" target="_blank" rel="noopener">${short(s.program.id)}</a> on Solana devnet</span>` : '<span class="off">Vault program not deployed</span>',
      s.ai.ok ? `<span class="on">Scam check on ${esc(s.ai.provider)}</span>` : '<span class="off">Scam check using rules only</span>',
      s.snowflake.ok ? '<span class="on">Scam reports from Snowflake</span>' : '<span class="off">Scam reports offline</span>',
      s.sms?.configured ? '<span class="on">Family texts via Twilio</span>' : '<span class="off">Family texts shown in app</span>',
    ].join('');
    paintNav();
  } catch {}
}
loadStatus();
setInterval(loadStatus, 20000);

function route() {
  clearInterval(timer);
  const h = location.hash || '#/';
  if (/[?&]as=family/.test(h) && role !== 'family') setRole('family');
  paintNav();
  window.scrollTo(0, 0);
  const m = h.match(/^#\/t\/(\w+)/);
  if (m) return paymentPage(m[1]);
  if (h.startsWith('#/payments')) return paymentsPage();
  if (role === 'family') return familyHome();
  if (h.startsWith('#/contact')) return contactPage();
  return sendPage();
}
window.addEventListener('hashchange', route);

const STATE_WORD = { scanning: 'Checking', held: 'Held', released: 'Sent', cancelled: 'Stopped', failed: 'Failed' };
const RISK_WORD = { high: 'High risk', medium: 'Elevated', low: 'Normal' };
const badge = (s) => `<span class="badge ${s}">${STATE_WORD[s] || s}</span>`;

function tableHTML(list, emptyText) {
  return `<table class="table">
    <thead><tr><th>Amount</th><th>Status</th><th>Recipient</th><th class="hide-sm">Risk</th><th class="hide-sm">Date</th></tr></thead>
    <tbody>${list.length ? list.map((t) => `
      <tr class="link" data-href="#/t/${t.id}">
        <td class="amt">${usd2(t.amountUsd)} <span class="dim">USD</span></td>
        <td>${badge(t.state)}</td>
        <td>${esc(t.payee.name)}</td>
        <td class="hide-sm">${t.risk?.level ? `<span class="score-dot ${t.risk.level}">${t.risk.score}</span>${RISK_WORD[t.risk.level]}` : '<span class="dim">—</span>'}</td>
        <td class="hide-sm dim">${stamp(t.createdAt)}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="empty">${emptyText}</td></tr>`}</tbody></table>`;
}
function wireRows() { view.querySelectorAll('tr.link').forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.href; })); }

// ---------- Rose: send money ----------
async function sendPage() {
  const c = await api('/api/contact').catch(() => ({}));
  const recent = (await api('/api/transfers').catch(() => [])).slice(0, 5);
  view.innerHTML = `
    <h1 class="page-title">Send money</h1>
    <p class="lead">Payments over $500 wait in a protected vault for 24 hours. If something looks like a scam, we explain why and ${esc(first(c.name) || 'your trusted contact')} can stop it.</p>
    <div class="send-grid">
      <form id="send" autocomplete="off">
        <div class="form-rows">
          <div class="frow"><label for="who">Recipient<small>Who is the money for?</small></label><input id="who" required></div>
          <div class="frow"><label for="amt">Amount</label><div class="money"><span>$</span><input id="amt" type="number" inputmode="numeric" min="1" max="15000" placeholder="0.00" required></div></div>
          <div class="frow"><label for="msg">Their message<small>Paste the text, email, or what they said on the phone</small></label><textarea id="msg"></textarea></div>
        </div>
        <div class="form-foot">
          <button class="btn primary lg" type="submit" data-busy="Checking">Review and send</button>
          <label><input type="checkbox" id="demo" checked> Demo hold of 90 seconds</label>
          <button type="button" class="linkbtn" id="example">Use an example scam text</button>
        </div>
      </form>
      <aside>
        <div class="panel-box"><h3>Trusted contact</h3><div class="body">
          <div class="who"><span class="avatar">${esc((c.name || '?')[0])}</span><div><b>${esc(c.name || 'Not set')}</b><span>${esc(c.relation || '')}${c.relation ? ' · ' : ''}${esc(c.masked || '')}</span></div></div>
          <a class="btn" href="#/contact" style="margin-top:14px">Edit contact</a></div></div>
        <div class="panel-box"><h3>How protection works</h3><div class="body"><ul class="howto">
          <li><b>The money waits.</b> It stays in a vault on Solana until the hold ends. Nobody can rush it.</li>
          <li><b>We check the request.</b> The message is scanned for known scam patterns and explained in plain English.</li>
          <li><b>${esc(first(c.name) || 'Your contact')} gets a text.</b> They can stop the payment with one tap.</li>
        </ul></div></div>
      </aside>
    </div>
    <section class="sec"><div class="sec-h"><h2>Recent payments</h2><a href="#/payments">View all</a></div>${tableHTML(recent, 'No payments yet.')}</section>`;
  wireRows();
  $('#example').addEventListener('click', () => { $('#who').value = EXAMPLE.payeeName; $('#amt').value = EXAMPLE.amountUsd; $('#msg').value = EXAMPLE.message; });
  $('#send').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('#send button[type=submit]'), async () => {
      const t = await api('/api/transfers', { payeeName: $('#who').value.trim(), amountUsd: Number($('#amt').value), message: $('#msg').value, demoHold: $('#demo').checked });
      location.hash = `#/t/${t.id}`;
    });
  });
}

async function paymentsPage() {
  view.innerHTML = `<h1 class="page-title">Payments</h1><p class="lead">Every large payment and what happened to it.</p><section class="sec" id="list"></section>`;
  const list = await api('/api/transfers').catch(() => []);
  $('#list').innerHTML = tableHTML(list, 'No payments yet.');
  wireRows();
}

async function contactPage() {
  const c = await api('/api/contact').catch(() => ({}));
  view.innerHTML = `
    <div class="settings">
      <h1 class="page-title">Trusted contact</h1>
      <p class="lead">This person gets a text whenever a large payment is waiting, and can stop it.</p>
      <form id="cf" class="sec">
        <div class="form-rows">
          <div class="frow"><label for="cn">Name</label><input id="cn" value="${esc(c.name || '')}" required></div>
          <div class="frow"><label for="cr">Relationship</label><input id="cr" value="${esc(c.relation || '')}" placeholder="Granddaughter"></div>
          <div class="frow"><label for="cp">Mobile number<small>Alerts are sent by text</small></label><input id="cp" type="tel" value="${esc(c.phone || '')}" placeholder="+1 732 555 0123" required></div>
        </div>
        <div class="form-foot"><button class="btn primary lg" type="submit" data-busy="Saving">Save contact</button></div>
      </form>
    </div>`;
  $('#cf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('#cf button'), async () => {
      const r = await api('/api/contact', { name: $('#cn').value, relation: $('#cr').value, phone: $('#cp').value });
      $('#cp').value = r.phone;
      toast(`Saved. ${first(r.name)} will get the alerts.`);
      loadStatus();
    });
  });
}

// ---------- Family overview ----------
async function familyHome() {
  const sen = STATUS?.people?.senior?.name || 'Rose Alvarez';
  view.innerHTML = `
    <h1 class="page-title">Overview</h1>
    <p class="lead">Large payments from ${esc(first(sen))} wait here first. Stop anything that doesn't look right.</p>
    <div class="stats" id="stats"></div>
    <section class="sec"><div class="sec-h"><h2>Needs your review</h2></div><div id="open"></div></section>
    <section class="sec"><div class="sec-h"><h2>Scams reported this month</h2><span class="meta" id="src"></span></div><div id="trend"></div></section>`;
  const paint = async () => {
    const [list, intel] = await Promise.all([api('/api/transfers').catch(() => []), api('/api/intel').catch(() => null)]);
    if (!$('#stats')) return;
    if (intel) {
      $('#stats').innerHTML = `
        <div class="stat"><span>Held right now</span><b>${usd(intel.heldUsd)}</b></div>
        <div class="stat"><span>Scams stopped</span><b>${intel.cancelledCount}</b></div>
        <div class="stat"><span>Money kept safe</span><b>${usd(intel.savedUsd)}</b></div>
        <div class="stat"><span>Scam reports, 30 days</span><b>${intel.reports30d.toLocaleString()}</b></div>`;
      $('#src').textContent = `Source: ${intel.source}`;
      $('#trend').innerHTML = `<table class="table"><thead><tr><th>Scam type</th><th class="num">Reports</th></tr></thead><tbody>${intel.topScripts.map((s) => `<tr><td>${esc(s.label.replace(/"/g, ''))}</td><td class="num">${s.reports30d}</td></tr>`).join('')}</tbody></table>`;
    }
    const open = list.filter((t) => ['held', 'scanning'].includes(t.state));
    $('#open').innerHTML = tableHTML(open, `Nothing to review. ${esc(first(sen))} hasn't sent anything large.`);
    wireRows();
  };
  await paint();
  timer = setInterval(paint, 4000);
}

// ---------- Payment detail ----------
function highlight(message, flags) {
  let html = esc(message);
  for (const q of (flags || []).map((f) => f.quote).filter((q) => q && q.length > 3 && !q.startsWith('$') && !/invisible/.test(q))) {
    const e = esc(q);
    if (html.includes(e)) html = html.replace(e, `<mark>${e}</mark>`);
  }
  return html;
}
const ATTACKS = [
  { kind: 'scammer', title: 'Recipient withdraws the funds', sub: 'Signed by the recipient wallet' },
  { kind: 'rush', title: 'Early release under pressure', sub: 'Signed by Rose before the hold ends' },
  { kind: 'redirect', title: 'Funds sent to another wallet', sub: 'Release with a different recipient' },
];

async function paymentPage(id) {
  let t;
  try { t = await api(`/api/transfers/${id}`); } catch { view.innerHTML = '<p class="lead">That payment wasn\'t found. <a href="#/payments">Back to payments</a></p>'; return; }
  let last = JSON.stringify(t);
  let blocked = false;
  const attackRes = {};
  const fam = () => role === 'family';

  const paint = () => {
    const r = t.risk, i = t.intel;
    const sen = first(t.senior.name), famName = first(t.family.name);
    const left = t.releaseAt ? Math.max(0, t.releaseAt - Math.floor(Date.now() / 1000)) : 0;
    const pct = t.holdSeconds ? Math.min(100, 100 - (left / t.holdSeconds) * 100) : 0;
    const held = t.state === 'held';
    const settleTx = t.txs.find((x) => x.kind === 'cancel' || x.kind === 'release');
    const holdTx = t.txs.find((x) => x.kind === 'hold');
    const acts = held
      ? (fam()
        ? `<button class="btn danger lg" data-act="cancel" data-busy="Stopping">${IC.stop} Stop payment</button><button class="btn lg" data-act="release" data-busy="Sending">${IC.send} Approve</button>`
        : `<button class="btn lg" data-act="cancel" data-busy="Cancelling">${IC.undo} Cancel payment</button><button class="btn primary lg" data-act="release" data-busy="Checking">${IC.send} Send now</button>`)
      : '';

    view.innerHTML = `
      <div class="detail">
        <div class="detail-main">
          <div class="kicker">${IC.pay} Payment</div>
          <div class="pay-top">
            <div class="amount-line"><span class="big">${usd2(t.amountUsd)} <small>USD</small></span>${badge(t.state)}</div>
            <div class="pay-acts">${acts}</div>
          </div>
          <div class="facts">
            <div class="fact"><span>Recipient</span><b>${esc(t.payee.name)}</b></div>
            <div class="fact"><span>From</span><b>${esc(t.senior.name)}</b></div>
            <div class="fact"><span>Trusted contact</span><b>${esc(t.family.name)}</b></div>
            <div class="fact"><span>Risk evaluation</span><b>${r ? `<span class="score-dot ${r.level}">${r.score}</span>${RISK_WORD[r.level]}` : '<span class="spin"></span>'}</b></div>
          </div>

          ${held && t.releaseAt ? `<div class="holdbar">
            <div class="row"><b>Held in the vault until ${timeOf(t.releaseAt)}</b><span class="clock" id="clock">${clock(left)}</span></div>
            <div class="meter"><i id="bar" style="width:${pct}%"></i></div>
            <div class="ends"><span>${fam() ? `${esc(sen)} or you can stop it any time` : `You or ${esc(famName)} can stop it any time`}</span><span>${left ? 'remaining' : 'hold is over'}</span></div>
            ${blocked ? `<div class="blocked">${IC.stop}<div><b>Early release refused</b><span>The Solana program won't release this payment before the hold ends, even if Rose is pressured into trying.</span></div></div>` : ''}
          </div>` : ''}
          ${t.state === 'scanning' ? '<div class="holdbar"><b><span class="spin"></span> Checking this payment…</b></div>' : ''}

          ${r ? `<section class="sec">
            <div class="sec-h"><h2>Scam check</h2><span class="meta">${r.by && r.by !== 'rules' ? `Explained by ${esc(r.by)}` : 'Rule-based check'}</span></div>
            <p class="verdict-text">${esc(r.explanation)}</p>
            ${fam() && r.familyNote ? `<p class="fam-note"><b>For you:</b> ${esc(r.familyNote)}</p>` : ''}
            ${r.flags.length ? `<dl class="dl" style="margin-top:14px">${r.flags.map((f) => `<dt>${esc(f.label)}</dt><dd class="quote">${f.quote ? `“${esc(f.quote)}”` : ''}</dd>`).join('')}</dl>` : ''}
            ${t.message ? `<div style="margin-top:18px"><div class="kicker">Message that asked for money</div><div class="msg">${highlight(t.message, r.flags)}</div></div>` : ''}
          </section>` : ''}

          <section class="sec">
            <div class="sec-h"><h2>Timeline</h2></div>
            <ul class="timeline">${t.events.map((e) => `<li class="${e.who === 'attack' ? 'warn' : ''}"><span class="ic">${e.who === 'attack' ? '!' : '✓'}</span><span><b>${esc(e.text)}</b><small>${stamp(e.at)}${e.url ? ` · <a href="${e.url}" target="_blank" rel="noopener">View on Solana</a>` : ''}</small></span><span></span></li>`).join('')}</ul>
          </section>

          <section class="sec">
            <div class="sec-h"><h2>Payment details</h2></div>
            <dl class="dl">
              <dt>Amount</dt><dd>${usd2(t.amountUsd)} USD <span class="sub">(${t.amountSol} SOL on devnet)</span></dd>
              <dt>Status</dt><dd>${STATE_WORD[t.state]}</dd>
              <dt>Hold</dt><dd>${t.holdSeconds ? `${t.holdSeconds < 120 ? `${t.holdSeconds} seconds (demo)` : `${Math.round(t.holdSeconds / 3600)} hours`}` : '—'}</dd>
              <dt>Vault</dt><dd>${t.vaultUrl ? `<a class="mono" href="${t.vaultUrl}" target="_blank" rel="noopener">${short(t.vault)}</a>` : '—'}</dd>
              <dt>Hold transaction</dt><dd>${holdTx ? `<a class="mono" href="${holdTx.url}" target="_blank" rel="noopener">${short(holdTx.sig)}</a>` : '—'}</dd>
              ${settleTx ? `<dt>${settleTx.kind === 'cancel' ? 'Return' : 'Release'} transaction</dt><dd><a class="mono" href="${settleTx.url}" target="_blank" rel="noopener">${short(settleTx.sig)}</a></dd>` : ''}
              ${t.receipt?.hash ? `<dt>Decision receipt</dt><dd><span class="mono">${t.receipt.hash.slice(0, 24)}…</span> <button class="linkbtn" id="vr" data-busy="Checking">Verify on Solana</button><div class="verify-out" id="rc"></div></dd>` : ''}
            </dl>
          </section>

          <section class="sec">
            <div class="sec-h"><h2>How it was checked</h2><span class="meta">${t.pipelineMs ? `${(t.pipelineMs / 1000).toFixed(1)} s total` : ''}</span></div>
            <ul class="timeline">${(t.pipeline || []).map((s) => `<li class="${s.state === 'blocked' ? 'warn' : s.state}"><span class="ic">${s.state === 'running' ? '' : s.state === 'blocked' ? '!' : '✓'}</span><span><b>${esc(s.label)}</b><small>${esc(s.detail || '')}</small></span><span class="ms">${s.ms != null ? `${s.ms} ms` : ''}</span></li>`).join('')}</ul>
          </section>
        </div>

        <aside class="side">
          <div class="side-h">Undo protection</div>
          <div class="side-body">
            <h2>Risk details</h2>
            ${i ? `<div class="side-sec"><h3>Scam reports</h3><div class="kv">
              <div><span>Pattern</span><span class="pill">${esc(i.label.replace(/"/g, ''))}</span></div>
              <div><span>Reports in 30 days</span><b>${i.reports30d}</b></div>
              <div><span>Lost to this scam</span><b>${usd(i.lossesUsd30d)}</b></div>
              ${i.recipientReports ? `<div><span>Reports naming "${esc(first(t.payee.name))}"</span><b>${i.recipientReports}</b></div>` : ''}
              <div><span>Source</span><b>${esc(i.source)}</b></div>
            </div></div>` : ''}
            ${r ? `<div class="side-sec"><h3>Assessment</h3><div class="kv">
              <div><span>Warning signs</span><b>${r.flags.length}</b></div>
              <div class="total"><span>Risk score</span><b>${r.score} / 100</b></div>
            </div></div>` : ''}
            ${t.sms ? `<div class="side-sec"><h3>${esc(famName)} was notified</h3><div class="kv"><div><span>Text message</span><b>${t.sms.sent ? `Sent to ${esc(t.family.phone || t.sms.to)}` : 'Shown in app'}</b></div></div>
              <div class="sms" style="margin-top:12px">${esc(t.sms.body)}</div>
              ${t.sms.template ? '<p class="lead" style="font-size:13px">Twilio trial accounts send a preset message. The full alert is shown above.</p>' : ''}</div>` : ''}
            ${held ? `<div class="side-sec"><h3>Security checks</h3><p class="lead" style="font-size:13.5px;margin:-4px 0 10px">Each is a real transaction the vault program must refuse.</p><div class="kv" style="border-top:1px solid var(--line)">
              ${ATTACKS.map((a) => `<div class="attack"><span>${a.title}<small>${a.sub}</small></span>${attackRes[a.kind] ? `<a class="refused" href="${attackRes[a.kind].url}" target="_blank" rel="noopener">Refused</a>` : `<button class="btn" data-attack="${a.kind}" data-busy="Trying">Run</button>`}</div>`).join('')}
              <div class="attack"><span>Read the vault<small id="vv">Straight from Solana</small></span><button class="btn" id="verify" data-busy="Reading">Read</button></div>
            </div></div>` : ''}
          </div>
        </aside>
      </div>`;
    wire();
  };

  const wire = () => {
    view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
      try {
        t = await api(`/api/transfers/${id}/${b.dataset.act}`, { by: fam() ? 'family' : 'senior' });
        blocked = false; last = JSON.stringify(t);
        toast(b.dataset.act === 'cancel' ? `Payment stopped. ${usd(t.amountUsd)} returned to ${first(t.senior.name)}.` : `Sent to ${t.payee.name}.`);
        paint();
      } catch (e) {
        if (/hold isn't over|rush/i.test(e.message)) { blocked = true; paint(); view.querySelector('.blocked')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); return; }
        throw e;
      }
    })));
    view.querySelectorAll('[data-attack]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
      const r = await api(`/api/transfers/${id}/attack`, { kind: b.dataset.attack });
      if (r.rejected) attackRes[b.dataset.attack] = r;
      toast(r.rejected ? `Refused on Solana: ${r.reason}.` : 'The hold had already ended.', !r.rejected);
      t = await api(`/api/transfers/${id}`); last = JSON.stringify(t);
      paint();
    })));
    $('#verify')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
      const v = await api(`/api/transfers/${id}/vault`);
      $('#vv').textContent = `${v.state === 'locked' ? 'Holding' : v.state} ${usd(v.amountUsd || 0)}, unlocks ${v.deadline ? timeOf(v.deadline) : '?'}`;
    }));
    $('#vr')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
      const r = await api(`/api/transfers/${id}/receipt`).catch((err) => ({ error: err.message }));
      if (!r.payload) throw new Error(r.error || 'No receipt yet');
      const mine = sha256hex(JSON.stringify(r.payload));
      let onchain = null;
      for (let k = 0; k < 3 && !onchain; k++) {
        try {
          const j = await fetch(r.rpc || 'https://api.devnet.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [r.sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }) }).then((x) => x.json());
          onchain = (j.result?.meta?.logMessages || []).find((l) => l.includes('pause:receipt:'))?.match(/pause:receipt:([0-9a-f]{64})/)?.[1] || null;
        } catch {}
        if (!onchain) await new Promise((res) => setTimeout(res, 700));
      }
      if (!onchain) onchain = r.onchain;
      const ok = !!onchain && onchain === mine;
      const out = $('#rc');
      out.className = `verify-out ${ok ? 'ok' : 'bad'}`;
      out.innerHTML = ok ? 'Verified. Your browser read the fingerprint from Solana and it matches.' : `Not matched yet. On Solana: ${esc(onchain || 'not found')}`;
    }));
  };

  const tick = async () => {
    const typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (['scanning', 'held'].includes(t.state)) {
      try {
        const nt = await api(`/api/transfers/${id}`);
        const j = JSON.stringify(nt);
        if (j !== last && !typing) { last = j; t = nt; paint(); return; }
      } catch {}
    }
    if (t.state === 'held' && t.releaseAt) {
      const left = Math.max(0, t.releaseAt - Math.floor(Date.now() / 1000));
      const c = $('#clock'); if (c) c.textContent = clock(left);
      const bar = $('#bar'); if (bar && t.holdSeconds) bar.style.width = `${Math.min(100, 100 - (left / t.holdSeconds) * 100)}%`;
    }
  };
  paint();
  timer = setInterval(tick, 1000);
}

// Tiny SHA-256 (crypto.subtle only exists on HTTPS pages).
function sha256hex(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes = Array.from(new TextEncoder().encode(str));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) | (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = r(w[t - 15], 7) ^ r(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = r(w[t - 2], 17) ^ r(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

function clock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

route();
