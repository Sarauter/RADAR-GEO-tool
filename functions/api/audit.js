/**
 * RADAR — Cloudflare Pages Function: GEO/AEO URL auditor.
 * Route: POST /api/audit   body: { "url": "example.com" }
 *
 * Runs server-side (no browser CORS limits). Fetches robots.txt, /llms.txt,
 * sitemap and the page HTML, then scores GEO/AEO readiness and returns a
 * prioritized list of findings, each linked to the constructor section that fixes it.
 *
 * No secrets required. Optional env var:
 *   AUDIT_USER_AGENT  — override the User-Agent used for outbound fetches.
 *
 * Response (matches the front-end audit view exactly):
 * {
 *   ok: true,
 *   url: "https://example.com/",
 *   scores: { content, distribution, geo },        // 0..100
 *   findings: [
 *     { severity: "critical"|"high"|"medium"|"low",
 *       section: "crawlers"|"zerozone"|"causal"|"tables"|"eeat"|"faqs",
 *       title:  { es, en },
 *       detail: { es, en } }
 *   ]
 * }
 * On error: { ok:false, error:"invalid_url"|"fetch_failed" }  (still HTTP 200, JSON)
 */

const AI_BOTS = [
  'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-user',
  'perplexitybot', 'perplexity-user', 'google-extended', 'ccbot',
  'bytespider', 'amazonbot', 'applebot-extended', 'meta-externalagent'
];

const DEFAULT_UA = 'RADAR-GEO-Auditor/1.0 (+https://sarauter.com; GEO/AEO readiness check)';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;

/* ============================ HTTP helper ============================ */
async function fetchText(target, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': ua, 'Accept': '*/*', 'Accept-Language': 'es,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (!res.ok || !res.body) {
      const text = res.ok ? await res.text().catch(() => '') : '';
      return { ok: res.ok, status: res.status, text: text.slice(0, MAX_BYTES) };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received > MAX_BYTES) { try { await reader.cancel(); } catch (_) {} break; }
    }
    const buf = new Uint8Array(Math.min(received, MAX_BYTES));
    let off = 0;
    for (const c of chunks) {
      if (off >= buf.length) break;
      const slice = c.subarray(0, Math.min(c.length, buf.length - off));
      buf.set(slice, off);
      off += slice.length;
    }
    return { ok: true, status: res.status, text: new TextDecoder('utf-8').decode(buf) };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ robots.txt ============================ */
function parseRobots(txt) {
  const out = { present: !!(txt && txt.trim()), blocked: [], sitemaps: [] };
  if (!out.present) return out;
  const lines = txt.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') { out.sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (cur && cur.rules.length) cur = null;
      if (!cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && cur) {
      cur.rules.push({ type: key, path: val });
    }
  }
  const isBlocked = (bot) => {
    const specific = groups.filter(g => g.agents.includes(bot));
    const wildcard = groups.filter(g => g.agents.includes('*'));
    const target = specific.length ? specific : wildcard;
    if (!target.length) return false;
    let blocked = false;
    for (const g of target) {
      for (const r of g.rules) {
        // Only "Disallow: /" blocks the whole site. Empty "Disallow:" means allow-all.
        if (r.type === 'disallow' && r.path === '/') blocked = true;
        if (r.type === 'allow' && (r.path === '/' || r.path === '')) blocked = false;
      }
    }
    return blocked;
  };
  out.blocked = AI_BOTS.filter(isBlocked);
  return out;
}

/* ============================ HTML analysis ============================ */
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try { blocks.push(JSON.parse(raw)); }
    catch (_) { try { blocks.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))); } catch (__) {} }
  }
  return blocks;
}

function collectTypes(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectTypes(n, acc)); return; }
  const t = node['@type'];
  if (t) (Array.isArray(t) ? t : [t]).forEach(x => acc.add(String(x).toLowerCase()));
  if (Array.isArray(node['@graph'])) node['@graph'].forEach(n => collectTypes(n, acc));
  ['mainEntity', 'author', 'publisher', 'itemListElement'].forEach(k => { if (node[k]) collectTypes(node[k], acc); });
}
function jsonLdHas(blocks, type) {
  const acc = new Set();
  blocks.forEach(b => collectTypes(b, acc));
  return acc.has(type.toLowerCase());
}
function jsonLdFindAuthorAndDate(blocks) {
  let author = null, date = null, sameAs = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!author && node.author) {
      const a = node.author;
      author = typeof a === 'string' ? a : (a.name || (Array.isArray(a) && a[0] && a[0].name) || null);
    }
    if (!date && (node.dateModified || node.datePublished)) date = node.dateModified || node.datePublished;
    if (node.sameAs) sameAs += (Array.isArray(node.sameAs) ? node.sameAs.length : 1);
    Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
  };
  blocks.forEach(walk);
  return { author, date, sameAs };
}
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const MEASURABLE_RE = /\d+(\.\d+)?\s?%|\d+(\.\d+)?\s?x\b|€\s?\d|\$\s?\d|\d+\s?(d[ií]as|days|horas|hours|semanas|weeks|meses|months|años|years|clientes|customers|usuarios|users|proyectos|projects|pa[ií]ses|countries)/gi;

function analyzeHtml(html) {
  const jsonld = extractJsonLd(html);
  const hasOrg = jsonLdHas(jsonld, 'organization') || jsonLdHas(jsonld, 'localbusiness');
  const hasArticle = jsonLdHas(jsonld, 'article') || jsonLdHas(jsonld, 'blogposting') || jsonLdHas(jsonld, 'newsarticle');
  const hasFaqPage = jsonLdHas(jsonld, 'faqpage');
  const { author: jAuthor, date: jDate, sameAs } = jsonLdFindAuthorAndDate(jsonld);
  const metaAuthor = (html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const author = jAuthor || metaAuthor || null;
  const metaDate = (html.match(/<meta[^>]+(?:property|name)=["'](?:article:modified_time|article:published_time|last-modified)["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const timeTag = (html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1];
  const date = jDate || metaDate || timeTag || null;
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const h1Text = h1 ? stripTags(h1) : '';
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const descWords = metaDesc.trim() ? metaDesc.trim().split(/\s+/).length : 0;
  const bodyText = stripTags(html).slice(0, 40000);
  const metrics = (bodyText.match(MEASURABLE_RE) || []).length;
  const headingQ = (html.match(/<h[2-4][^>]*>\s*[^<]*\?\s*<\/h[2-4]>/gi) || []).length;
  return { hasOrg, hasArticle, hasFaqPage, author, date, sameAs, h1Text, descWords, metrics, headingQ };
}

/* ============================ Analysis → findings + scores ============================ */
function lvlScore(level) { return level === 'green' ? 90 : level === 'yellow' ? 55 : 20; }

function analyze({ url, html, robotsTxt, hasLlms }) {
  const robots = parseRobots(robotsTxt);
  const h = analyzeHtml(html);
  const findings = [];
  const F = (severity, section, esT, enT, esD, enD) =>
    findings.push({ severity, section, title: { es: esT, en: enT }, detail: { es: esD, en: enD } });

  /* R — crawler access */
  let crawlLevel;
  if (robots.blocked.length) {
    crawlLevel = 'red';
    F('critical', 'crawlers',
      'robots.txt bloquea bots de IA', 'robots.txt blocks AI bots',
      `Bloqueas: ${robots.blocked.join(', ')}. Esos motores no pueden leer tu sitio, así que nunca te citarán.`,
      `You block: ${robots.blocked.join(', ')}. Those engines cannot read your site, so they will never cite you.`);
  } else if (!robots.present) {
    crawlLevel = 'yellow';
    F('medium', 'crawlers',
      'Sin robots.txt', 'No robots.txt',
      'No hay robots.txt. Añade uno que permita explícitamente GPTBot, ClaudeBot, PerplexityBot y Google-Extended.',
      'No robots.txt. Add one that explicitly allows GPTBot, ClaudeBot, PerplexityBot and Google-Extended.');
  } else {
    crawlLevel = 'green';
  }
  if (!hasLlms) {
    F('low', 'crawlers',
      'Sin archivo llms.txt', 'No llms.txt file',
      'Añade /llms.txt para guiar a los motores de IA hacia tu contenido clave.',
      'Add /llms.txt to guide AI engines to your key content.');
    if (crawlLevel === 'green') crawlLevel = 'yellow';
  }

  /* D — structured data */
  const schemaLevel = (h.hasOrg && (h.hasArticle || h.hasFaqPage)) ? 'green'
    : (h.hasOrg || h.hasArticle || h.hasFaqPage) ? 'yellow' : 'red';
  if (schemaLevel !== 'green') {
    F(schemaLevel === 'red' ? 'critical' : 'high', 'eeat',
      'Faltan datos estructurados', 'Missing structured data',
      `Sin JSON-LD${h.hasOrg ? '' : ' Organization'}${h.hasArticle ? '' : ' + Article'}, los motores no entienden qué eres ni qué publicas.`,
      `Without JSON-LD${h.hasOrg ? '' : ' Organization'}${h.hasArticle ? '' : ' + Article'}, engines cannot understand what you are or what you publish.`);
  }

  /* A — authorship + date */
  const authLevel = (h.author && h.date) ? 'green' : (h.author || h.date) ? 'yellow' : 'red';
  if (authLevel !== 'green') {
    F(authLevel === 'red' ? 'high' : 'medium', 'eeat',
      'Autoría o fecha ausente', 'Missing authorship or date',
      `${h.author ? 'Falta la fecha de actualización' : 'No se detecta autor'}${(!h.author && !h.date) ? ' ni fecha' : ''}. Sin firma ni fecha, falta la señal E-E-A-T mínima.`,
      `${h.author ? 'Missing update date' : 'No author detected'}${(!h.author && !h.date) ? ' or date' : ''}. Without a byline or date, the minimal E-E-A-T signal is missing.`);
  }

  /* A — answer structure (atomicity) */
  const h1ok = h.h1Text && h.h1Text.length > 8;
  const shortSummary = h.descWords > 0 && h.descWords <= 40;
  const answerLevel = (h1ok && shortSummary) ? 'green' : (h1ok || shortSummary) ? 'yellow' : 'red';
  if (answerLevel !== 'green') {
    F(answerLevel === 'red' ? 'high' : 'medium', 'zerozone',
      'Sin respuesta atómica clara', 'No clear atomic answer',
      'Las páginas no abren con H1 + resumen corto. El LLM no encuentra una respuesta directa que extraer.',
      'Pages do not open with an H1 + short summary. The LLM finds no direct answer to extract.');
  }

  /* D — measurable data */
  const metricLevel = h.metrics >= 3 ? 'green' : h.metrics >= 1 ? 'yellow' : 'red';
  if (metricLevel !== 'green') {
    F('medium', 'causal',
      'Pocos datos medibles', 'Few measurable data points',
      `Detectamos ${h.metrics} cifra(s) verificable(s). Añade %, plazos y resultados que un motor pueda citar.`,
      `We found ${h.metrics} verifiable figure(s). Add %, timeframes and results an engine can cite.`);
  }

  /* R — FAQ block */
  const faqLevel = h.hasFaqPage ? 'green' : h.headingQ >= 3 ? 'yellow' : 'red';
  if (faqLevel !== 'green') {
    F(faqLevel === 'red' ? 'critical' : 'medium', 'faqs',
      'Sin FAQ estructurada', 'No structured FAQ',
      'No hay FAQ con datos estructurados (FAQPage). Los motores no tienen preguntas listas para extraer.',
      'No FAQ with structured data (FAQPage). Engines have no ready-to-extract questions.');
  }

  /* scores */
  const weights = { schema: 0.22, authorship: 0.20, answer: 0.20, metrics: 0.18, faq: 0.20 };
  const levels = { schema: schemaLevel, authorship: authLevel, answer: answerLevel, metrics: metricLevel, faq: faqLevel };
  let content = 0;
  Object.keys(weights).forEach(k => { content += lvlScore(levels[k]) * weights[k]; });
  const cap = crawlLevel === 'red' ? 40 : crawlLevel === 'yellow' ? 75 : 100;
  content = Math.min(Math.round(content), cap);
  const distribution = Math.min(100, 15 + (h.sameAs || 0) * 12 + (hasLlms ? 15 : 0));
  const geo = Math.round((content + distribution) / 2);

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { url, scores: { content, distribution, geo }, findings };
}

/* ============================ Handler ============================ */
function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed;
  } catch (_) { return null; }
}
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
  const ua = (env && env.AUDIT_USER_AGENT) || DEFAULT_UA;

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const parsed = normalizeUrl(body && body.url);
  if (!parsed) return json({ ok: false, error: 'invalid_url' });

  const origin = parsed.origin;
  const [htmlRes, robotsRes, llmsRes] = await Promise.all([
    fetchText(parsed.href, ua),
    fetchText(origin + '/robots.txt', ua),
    fetchText(origin + '/llms.txt', ua)
  ]);

  if (!htmlRes.ok || !htmlRes.text) {
    // timeout, DNS failure, 4xx/5xx, or the site blocks our bot
    return json({ ok: false, error: 'fetch_failed' });
  }

  try {
    const result = analyze({
      url: parsed.href,
      html: htmlRes.text,
      robotsTxt: robotsRes.ok ? robotsRes.text : '',
      hasLlms: !!(llmsRes.ok && llmsRes.text && llmsRes.text.trim())
    });
    return json(Object.assign({ ok: true }, result));
  } catch (e) {
    return json({ ok: false, error: 'fetch_failed' });
  }
}

// Also allow GET for quick manual checks (?url=...), same contract.
export async function onRequestGet(context) {
  const { request } = context;
  const u = new URL(request.url).searchParams.get('url');
  const fakeReq = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: u })
  });
  return onRequestPost(Object.assign({}, context, { request: fakeReq }));
}

// Exported for local unit testing (unused by the Pages runtime).
export const __test = { parseRobots, analyzeHtml, analyze, normalizeUrl };
