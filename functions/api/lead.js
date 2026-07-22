/**
 * RADAR — Cloudflare Pages Function: contact / lead capture.
 * Route: POST /api/lead
 * body: { firstName, lastName, email, company, message, consent, intent, url, score, lang }
 *
 * Delivers the lead through whichever channel you configure. Pick ONE:
 *
 *  A) Webhook (easiest — Zapier / Make / Formspree / n8n):
 *       LEAD_WEBHOOK_URL   — the function POSTs the JSON payload to this URL.
 *
 *  B) Email via Resend (https://resend.com):
 *       RESEND_API_KEY     — your Resend API key.
 *       LEAD_TO            — recipient address, e.g. marketing@sarauter.com
 *       LEAD_FROM          — verified sender, e.g. "RADAR <no-reply@sarauter.com>"
 *
 * If neither is configured the function returns { ok:false, error:"not_configured" }
 * and the front-end shows a generic "couldn't send" message. No secrets in the repo —
 * set these in Cloudflare → Pages → Settings → Environment variables.
 *
 * Responses (HTTP 200, JSON):
 *   { ok: true }
 *   { ok: false, error: "invalid" | "not_configured" | "send_failed" }
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

function esc(s) { return String(s == null ? '' : s); }

function buildEmail(p) {
  const lines = [
    `Nombre: ${esc(p.firstName)} ${esc(p.lastName)}`,
    `Email: ${esc(p.email)}`,
    `Empresa: ${esc(p.company) || '—'}`,
    `Mensaje: ${esc(p.message) || '—'}`,
    `Origen: ${esc(p.intent) || '—'}`,
    `URL auditada: ${esc(p.url) || '—'}`,
    `Score GEO: ${esc(p.score) || '—'}`,
    `Idioma: ${esc(p.lang) || '—'}`
  ];
  return lines.join('\n');
}

async function sendViaWebhook(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.ok;
}

async function sendViaResend(env, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.LEAD_FROM || 'RADAR <onboarding@resend.dev>',
      to: [env.LEAD_TO],
      reply_to: payload.email,
      subject: `RADAR — nuevo contacto: ${esc(payload.firstName)} ${esc(payload.lastName)}`,
      text: buildEmail(payload)
    })
  });
  return res.ok;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let p = {};
  try { p = await request.json(); } catch (_) { p = {}; }

  // Minimal server-side validation (front-end also validates).
  if (!p || !p.firstName || !p.lastName || !EMAIL_RE.test(String(p.email || '')) || !p.consent) {
    return json({ ok: false, error: 'invalid' });
  }

  const payload = {
    firstName: p.firstName, lastName: p.lastName, email: p.email,
    company: p.company || '', message: p.message || '',
    intent: p.intent || '', url: p.url || '', score: p.score || '',
    lang: p.lang || '', receivedAt: new Date().toISOString()
  };

  try {
    if (env && env.LEAD_WEBHOOK_URL) {
      const ok = await sendViaWebhook(env.LEAD_WEBHOOK_URL, payload);
      return ok ? json({ ok: true }) : json({ ok: false, error: 'send_failed' });
    }
    if (env && env.RESEND_API_KEY && env.LEAD_TO) {
      const ok = await sendViaResend(env, payload);
      return ok ? json({ ok: true }) : json({ ok: false, error: 'send_failed' });
    }
    return json({ ok: false, error: 'not_configured' });
  } catch (_) {
    return json({ ok: false, error: 'send_failed' });
  }
}
