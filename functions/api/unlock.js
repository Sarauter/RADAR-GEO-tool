/**
 * RADAR — Cloudflare Pages Function: team login (unlock the optimizer).
 * Route: POST /api/unlock   body: { "user": "...", "password": "..." }
 *
 * Checks the password against a Cloudflare environment variable so the secret
 * never lives in the repo.
 *
 * Environment variables (Cloudflare → Pages → Settings → Environment variables):
 *   OPTIMIZER_PASSWORD  (required)  — the team password.
 *   OPTIMIZER_USER      (optional)  — if set, the username must match too.
 *
 * Responses (HTTP 200, JSON — matches the front-end submitLogin()):
 *   { ok: true }                              → unlocked
 *   { ok: false, error: "not_configured" }    → OPTIMIZER_PASSWORD not set
 *   { ok: false, error: "bad" }               → wrong user/password
 */

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

// Length-independent, best-effort constant-time string compare.
function safeEqual(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
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

  const expectedPass = env && env.OPTIMIZER_PASSWORD;
  if (!expectedPass) return json({ ok: false, error: 'not_configured' });

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const user = (body && body.user) || '';
  const pass = (body && body.password) || '';

  const expectedUser = env && env.OPTIMIZER_USER; // optional
  const userOk = expectedUser ? safeEqual(user, expectedUser) : true;
  const passOk = safeEqual(pass, expectedPass);

  if (userOk && passOk) return json({ ok: true });
  return json({ ok: false, error: 'bad' });
}
