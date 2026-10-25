// Text the family member on file via Twilio's REST API.
// Twilio trial accounts can't send custom wording, only Twilio's built-in templates. So if the
// custom text is refused, Pause sends the built-in "account alert" template instead: the phone
// still buzzes in real time, and the full explanation lives in the app.
// Without Twilio configured, the text is shown in the app as simulated so the demo never breaks.
export const SMS = {
  configured: !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN),
};

async function send(params) {
  const sid = process.env.TWILIO_SID.trim();
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_TOKEN.trim()}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Twilio ${r.status}`);
  return j;
}

export async function textFamily(body, phone) {
  const to = String(phone || process.env.FAMILY_PHONE || '').trim();
  if (!SMS.configured || !to) return { sent: false, simulated: true, body, to: 'family phone (simulated)' };
  const masked = `•••${to.slice(-4)}`;
  // Trial mode: send exactly the request Twilio's console uses (template body + assigned From).
  if (process.env.TWILIO_TEMPLATE) {
    try {
      const params = { To: to, Body: process.env.TWILIO_TEMPLATE.trim() };
      if (process.env.TWILIO_FROM) params.From = process.env.TWILIO_FROM.trim();
      const j = await send(params);
      return { sent: true, template: true, sid: j.sid, body, to: masked };
    } catch (e) {
      console.log('[sms] template send failed:', e.message);
      return { sent: false, simulated: true, error: e.message, body, to: 'family phone (simulated)' };
    }
  }
  try {
    const params = { To: to, Body: body };
    if (process.env.TWILIO_FROM) params.From = process.env.TWILIO_FROM.trim();
    const j = await send(params);
    return { sent: true, sid: j.sid, body, to: masked };
  } catch (e) {
    if (!/template|trial/i.test(e.message)) {
      console.log('[sms] failed:', e.message);
      return { sent: false, simulated: true, error: e.message, body, to: 'family phone (simulated)' };
    }
    try {
      const tpl = { To: to, Body: process.env.TWILIO_TEMPLATE || 'sms_account_alerts' };
      let j;
      try {
        j = await send(process.env.TWILIO_FROM ? { ...tpl, From: process.env.TWILIO_FROM.trim() } : tpl);
      } catch (e3) {
        if (!process.env.TWILIO_FROM) throw e3;
        j = await send(tpl);
      }
      return { sent: true, template: true, sid: j.sid, body, to: masked };
    } catch (e2) {
      console.log('[sms] template send failed:', e2.message);
      return { sent: false, simulated: true, error: e2.message, body, to: 'family phone (simulated)' };
    }
  }
}
