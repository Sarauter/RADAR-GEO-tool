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
 *   scores: { index, band, blocked }               // index 0..100 (null if blocked);
 *                                                   // band: "critical"|"improvable"|"good"|"invisible";
 *                                                   // if blocked: + blockedBots:[{label,url|null}]
 *   dimensions: [                                   // always 5, in order:
 *     { key: "schema"|"authorship"|"answer"|"metrics"|"faq",
 *       level: "green"|"yellow"|"red",
 *       section: "eeat"|"zerozone"|"causal"|"faqs", // constructor step that fixes it
 *       status: { es, en },                         // per-site status text
 *       source: { label: { es, en }, url } }        // official documentation
 *   ],
 *   llmsMissing: true|false,
 *   data: { ... }                                   // autofill payload (unchanged)
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

/* ============================ Autofill extraction ============================ */
function firstMatch(re, s) { const m = (s || '').match(re); return m ? m[1] : ''; }

function metaContent(html, attr, value) {
  // Isolate each <meta ...> tag first (bounded by its own '>'), then look for
  // the attr/content pair inside that single tag. This avoids the case where
  // a lazy content-value match backtracks across '>' into a LATER <meta> tag
  // when the current tag doesn't have the attribute we're looking for (which
  // happened with the naive single cross-tag regex, independent of attribute
  // order).
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrRe = new RegExp(attr + '=["\']' + esc + '["\']', 'i');
  const tagRe = /<meta[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    if (attrRe.test(tag)) {
      const cm = tag.match(/content=(["'])([\s\S]*?)\1/i);
      if (cm) return cm[2];
    }
  }
  return '';
}

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&(?:lt|#0*60|#x0*3c);/gi, '<')
    .replace(/&(?:gt|#0*62|#x0*3e);/gi, '>')
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
    .replace(/&(?:nbsp|#0*160|#x0*a0);/gi, ' ')
    .replace(/&(?:ndash|#0*8211|#x0*2013);/gi, '–')
    .replace(/&(?:mdash|#0*8212|#x0*2014);/gi, '—')
    .replace(/&(?:rsquo|#0*8217|#x0*2019);/gi, '’')
    .replace(/&(?:lsquo|#0*8216|#x0*2018);/gi, '‘')
    .replace(/&(?:ldquo|#0*8220|#x0*201c);/gi, '“')
    .replace(/&(?:rdquo|#0*8221|#x0*201d);/gi, '”')
    .replace(/&#(\d+);/g, function (_, n) { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return _; } })
    .replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
}

function extractFaqPairs(blocks) {
  const pairs = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const types = node['@type'] ? (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) : [];
    if (types.map(t => String(t).toLowerCase()).indexOf('question') >= 0) {
      const q = decodeEntities(String(node.name || '')).trim();
      const ans = node.acceptedAnswer;
      let a = ans ? (typeof ans === 'string' ? ans : (ans.text || (Array.isArray(ans) && ans[0] && ans[0].text) || '')) : '';
      a = decodeEntities(stripTags(String(a))).trim();
      if (q && a) pairs.push({ question: q, answer: a });
    }
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(walk);
    Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
  };
  blocks.forEach(walk);
  const seen = {};
  return pairs.filter(p => { if (seen[p.question]) return false; seen[p.question] = true; return true; });
}

function extractAutofill(html, robotsTxt, parsed) {
  const jsonld = extractJsonLd(html);
  const ogSite = metaContent(html, 'property', 'og:site_name');
  let title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  title = stripTags(title).replace(/\s*[|–—\-]\s[\s\S]*$/, '').trim();
  const brandName = decodeEntities(ogSite || title || '').trim();

  const metaDesc = metaContent(html, 'name', 'description');
  const ogDesc = metaContent(html, 'property', 'og:description');
  const description = decodeEntities(metaDesc || ogDesc || '').trim();

  const h1raw = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const h1 = h1raw ? decodeEntities(stripTags(h1raw)).trim() : '';

  const robotsMeta = metaContent(html, 'name', 'robots');
  const metaNoindex = /noindex/i.test(robotsMeta) ? 'si' : 'no';

  const bodyText = stripTags(html);
  const jsRendered = bodyText.length > 600 ? 'si' : 'unsure';

  const faqs = extractFaqPairs(jsonld);

  return {
    website: parsed.href,
    domain: parsed.hostname,
    robotsText: robotsTxt || '',
    metaNoindex: metaNoindex,
    jsRendered: jsRendered,
    brandName: brandName,
    description: description,
    h1: h1,
    faqs: faqs
  };
}

/* ============================ Sources & bot registry ============================ */
const SOURCES = {
  schema: { url: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
    label: { es: 'Google · Datos estructurados', en: 'Google · Structured data' } },
  eeat: { url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
    label: { es: 'Google · Contenido útil y E-E-A-T', en: 'Google · Helpful content & E-E-A-T' } },
  noindex: { url: 'https://developers.google.com/search/docs/crawling-indexing/block-indexing',
    label: { es: 'Google · Bloquear indexación (noindex)', en: 'Google · Block indexing (noindex)' } },
  gptbot: { url: 'https://developers.openai.com/api/docs/bots',
    label: { es: 'OpenAI · Bots y robots.txt', en: 'OpenAI · Bots & robots.txt' } },
  claudebot: { url: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
    label: { es: 'Anthropic · Rastreo web', en: 'Anthropic · Web crawling' } },
  perplexitybot: { url: 'https://docs.perplexity.ai/docs/resources/perplexity-crawlers',
    label: { es: 'Perplexity · Crawlers', en: 'Perplexity · Crawlers' } },
  googleExtended: { url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
    label: { es: 'Google · Google-Extended', en: 'Google · Google-Extended' } },
  llmstxt: { url: 'https://llmstxt.org/',
    label: { es: 'llms.txt (propuesta)', en: 'llms.txt (proposal)' } }
};

// Nombre legible + fuente por bot (ids en minúscula, como los devuelve parseRobots).
const BOT_INFO = {
  'gptbot': { label: 'GPTBot (OpenAI)', src: 'gptbot' },
  'oai-searchbot': { label: 'OAI-SearchBot (OpenAI)', src: 'gptbot' },
  'chatgpt-user': { label: 'ChatGPT-User (OpenAI)', src: 'gptbot' },
  'claudebot': { label: 'ClaudeBot (Anthropic)', src: 'claudebot' },
  'claude-user': { label: 'Claude-User (Anthropic)', src: 'claudebot' },
  'perplexitybot': { label: 'PerplexityBot (Perplexity)', src: 'perplexitybot' },
  'perplexity-user': { label: 'Perplexity-User (Perplexity)', src: 'perplexitybot' },
  'google-extended': { label: 'Google-Extended (Google)', src: 'googleExtended' },
  'ccbot': { label: 'CCBot (Common Crawl)', src: null },
  'bytespider': { label: 'Bytespider (ByteDance)', src: null },
  'amazonbot': { label: 'Amazonbot (Amazon)', src: null },
  'applebot-extended': { label: 'Applebot-Extended (Apple)', src: null },
  'meta-externalagent': { label: 'Meta-ExternalAgent (Meta)', src: null }
};

// Texto por-web del estado de cada dimensión (depende de lo detectado en la web).
function dimStatus(key, level, h) {
  const T = {
    schema: {
      green:  { es: 'Detectamos Organization y Article/FAQPage.', en: 'Organization and Article/FAQPage detected.' },
      yellow: { es: 'Solo detectamos parte del schema; falta completarlo.', en: 'Only part of the schema detected; it needs completing.' },
      red:    { es: 'No detectamos datos estructurados en la portada.', en: 'No structured data detected on the homepage.' }
    },
    authorship: {
      green:  { es: 'Detectamos autor y fecha de actualización.', en: 'Author and update date detected.' },
      yellow: { es: 'Detectamos autor o fecha, pero no ambos.', en: 'Author or date detected, but not both.' },
      red:    { es: 'No detectamos autor ni fecha en la portada.', en: 'No author or date detected on the homepage.' }
    },
    answer: {
      green:  { es: 'La portada abre con un titular claro y un resumen corto.', en: 'The homepage opens with a clear headline and a short summary.' },
      yellow: { es: 'Tienes titular o resumen corto, pero no ambos.', en: 'You have a headline or a short summary, but not both.' },
      red:    { es: 'La portada no abre con titular claro y resumen corto.', en: 'The homepage does not open with a clear headline and short summary.' }
    },
    metrics: {
      green:  { es: `Detectamos ${h.metrics} cifras verificables.`, en: `${h.metrics} verifiable figures detected.` },
      yellow: { es: `Detectamos ${h.metrics} cifra(s); añade más.`, en: `${h.metrics} figure(s) detected; add more.` },
      red:    { es: 'No detectamos cifras verificables en la portada.', en: 'No verifiable figures detected on the homepage.' }
    },
    faq: {
      green:  { es: 'Tienes una FAQ con datos estructurados (FAQPage).', en: 'You have an FAQ with structured data (FAQPage).' },
      yellow: { es: 'Tienes preguntas, pero sin datos estructurados (FAQPage).', en: 'You have questions, but no structured data (FAQPage).' },
      red:    { es: 'No detectamos preguntas frecuentes en la portada.', en: 'No FAQ detected on the homepage.' }
    }
  };
  return T[key][level];
}

/* ============================ Analysis → findings + scores ============================ */
function lvlScore(level) { return level === 'green' ? 90 : level === 'yellow' ? 55 : 20; }

function analyze({ url, html, robotsTxt, hasLlms }) {
  const robots = parseRobots(robotsTxt);
  const h = analyzeHtml(html);

  // Nivel de cada dimensión (mismos umbrales de siempre).
  const schemaLevel = (h.hasOrg && (h.hasArticle || h.hasFaqPage)) ? 'green'
    : (h.hasOrg || h.hasArticle || h.hasFaqPage) ? 'yellow' : 'red';
  const authLevel = (h.author && h.date) ? 'green' : (h.author || h.date) ? 'yellow' : 'red';
  const h1ok = h.h1Text && h.h1Text.length > 8;
  const shortSummary = h.descWords > 0 && h.descWords <= 40;
  const answerLevel = (h1ok && shortSummary) ? 'green' : (h1ok || shortSummary) ? 'yellow' : 'red';
  const metricLevel = h.metrics >= 3 ? 'green' : h.metrics >= 1 ? 'yellow' : 'red';
  const faqLevel = h.hasFaqPage ? 'green' : h.headingQ >= 3 ? 'yellow' : 'red';

  // section = paso del constructor que lo arregla (mismos valores que usaba fixFinding).
  const defs = [
    { key: 'schema',     level: schemaLevel, section: 'eeat',     source: SOURCES.schema },
    { key: 'authorship', level: authLevel,   section: 'eeat',     source: SOURCES.eeat },
    { key: 'answer',     level: answerLevel, section: 'zerozone', source: SOURCES.eeat },
    { key: 'metrics',    level: metricLevel, section: 'causal',   source: SOURCES.eeat },
    { key: 'faq',        level: faqLevel,    section: 'faqs',     source: SOURCES.schema }
  ];
  const dimensions = defs.map(d => ({
    key: d.key, level: d.level, section: d.section,
    status: dimStatus(d.key, d.level, h),
    source: { label: d.source.label, url: d.source.url }
  }));

  // Índice = media simple de los 5 niveles. Sin pesos, sin techos.
  const idx = Math.round(
    dimensions.reduce((sum, d) => sum + lvlScore(d.level), 0) / dimensions.length
  );

  let scores;
  if (robots.blocked.length) {
    const blockedBots = robots.blocked.map(id => {
      const info = BOT_INFO[id] || { label: id, src: null };
      return { label: info.label, url: info.src ? SOURCES[info.src].url : null };
    });
    scores = { index: null, band: 'invisible', blocked: true, blockedBots };
  } else {
    const band = idx <= 40 ? 'critical' : idx <= 70 ? 'improvable' : 'good';
    scores = { index: idx, band, blocked: false };
  }

  return { url, scores, dimensions, llmsMissing: !hasLlms };
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
    const data = extractAutofill(htmlRes.text, robotsRes.ok ? robotsRes.text : '', parsed);
    return json(Object.assign({ ok: true }, result, { data: data }));
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
export const __test = { parseRobots, analyzeHtml, analyze, normalizeUrl, dimStatus };
