/**
 * RADAR — Cloudflare Pages Function: GEO/AEO URL auditor.
 * Route: POST /api/audit   body: { "url": "example.com" }
 *
 * Runs server-side (no browser CORS limits). Fetches robots.txt, /llms.txt,
 * the sitemap and the page HTML, then scores GEO/AEO readiness across 12
 * signals grouped in 3 blocks, each linked to the constructor section that fixes it.
 *
 * IMPORTANT: only ONE page is analysed (the URL received), never the whole site.
 * The front-end must say so visibly.
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
 *   blocks: [                                       // always 3, in order:
 *     { key: "access"|"understanding"|"content", score, level }
 *   ],
 *   dimensions: [                                   // always 12, grouped by block, in order:
 *     { key, block, level: "green"|"yellow"|"red",
 *       section: "crawlers"|"eeat"|"zerozone"|"causal"|"faqs",
 *       status: { es, en },                         // per-page status text
 *       source: { label: { es, en }, url } }        // official documentation
 *   ],
 *   llmsMissing: true|false,
 *   data: { ... }                                   // autofill payload (unchanged)
 * }
 * On error: { ok:false, error:"invalid_url"|"fetch_failed" }  (still HTTP 200, JSON)
 */

/* Bots que deciden si te CITAN en una respuesta de IA. Bloquear uno de estos = invisible. */
const CITATION_BOTS = [
  'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-user',
  'perplexitybot', 'perplexity-user', 'google-extended'
];
/* Bots de entrenamiento / archivo. Bloquearlos es una decisión legítima, no una alarma. */
const TRAINING_BOTS = [
  'ccbot', 'bytespider', 'amazonbot', 'applebot-extended', 'meta-externalagent'
];
const AI_BOTS = CITATION_BOTS.concat(TRAINING_BOTS);

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
    // Cabeceras que influyen en el diagnóstico (X-Robots-Tag puede traer noindex/nosnippet
    // sin que aparezca ninguna etiqueta <meta> en el HTML).
    const headers = {
      xRobots: res.headers.get('x-robots-tag') || '',
      lastModified: res.headers.get('last-modified') || ''
    };
    if (!res.ok || !res.body) {
      const text = res.ok ? await res.text().catch(() => '') : '';
      return { ok: res.ok, status: res.status, headers, text: text.slice(0, MAX_BYTES) };
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
    return { ok: true, status: res.status, headers, text: new TextDecoder('utf-8').decode(buf) };
  } catch (e) {
    return {
      ok: false, status: 0, text: '', headers: { xRobots: '', lastModified: '' },
      error: (e && e.name === 'AbortError') ? 'timeout' : 'network'
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ robots.txt ============================ */
function parseRobots(txt) {
  const out = { present: !!(txt && txt.trim()), blocked: [], blockedCitation: [], blockedTraining: [], sitemaps: [] };
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
  out.blockedCitation = CITATION_BOTS.filter(isBlocked);
  out.blockedTraining = TRAINING_BOTS.filter(isBlocked);
  out.blocked = out.blockedCitation.concat(out.blockedTraining);
  return out;
}

/* ============================ JSON-LD ============================ */
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, found = 0;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    found++;
    try { blocks.push(JSON.parse(raw)); }
    catch (_) { try { blocks.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))); } catch (__) {} }
  }
  blocks.found = found;   // cuántos bloques había en el HTML (parseasen o no)
  return blocks;
}

function collectTypes(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectTypes(n, acc)); return; }
  const t = node['@type'];
  if (t) (Array.isArray(t) ? t : [t]).forEach(x => acc.add(String(x).toLowerCase()));
  if (Array.isArray(node['@graph'])) node['@graph'].forEach(n => collectTypes(n, acc));
  ['mainEntity', 'author', 'publisher', 'itemListElement', 'creator', 'about', 'provider']
    .forEach(k => { if (node[k]) collectTypes(node[k], acc); });
}
function allJsonLdTypes(blocks) {
  const acc = new Set();
  blocks.forEach(b => collectTypes(b, acc));
  return acc;
}
function jsonLdHas(blocks, type) {
  return allJsonLdTypes(blocks).has(String(type).toLowerCase());
}

/* Tipos que dicen QUIÉN eres, y tipos que dicen QUÉ hay en la página. */
const IDENTITY_TYPES = ['organization', 'localbusiness', 'person',
  'professionalservice', 'website', 'corporation', 'ngo', 'educationalorganization'];
const CONTENT_TYPES = ['article', 'blogposting', 'newsarticle', 'faqpage', 'howto',
  'product', 'service', 'breadcrumblist', 'collectionpage', 'webpage', 'qapage',
  'profilepage', 'aboutpage', 'contactpage', 'itemlist', 'softwareapplication',
  'event', 'course', 'recipe'];

/* Autor, fecha, sameAs, nombre de entidad y datos de contacto — todo en una pasada. */
function jsonLdFacts(blocks) {
  let author = null, date = null, sameAs = 0, entityName = null, hasContact = false;
  const idSet = new Set(IDENTITY_TYPES);
  const nameOf = (a) => {
    if (!a) return null;
    if (typeof a === 'string') return a.trim() || null;
    if (Array.isArray(a)) { for (const x of a) { const n = nameOf(x); if (n) return n; } return null; }
    return (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : null;
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    const types = node['@type']
      ? (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).map(t => String(t).toLowerCase())
      : [];

    // Autor: author / creator / publisher, y también la Person o la Organization
    // que la página declara como entidad principal (caso ProfilePage → mainEntity: Person).
    if (!author) author = nameOf(node.author) || nameOf(node.creator);
    if (!author && types.some(t => t === 'person')) author = nameOf(node);
    if (!author) author = nameOf(node.publisher);

    if (!date && (node.dateModified || node.datePublished)) date = node.dateModified || node.datePublished;
    if (node.sameAs) sameAs += (Array.isArray(node.sameAs) ? node.sameAs.length : 1);

    if (!entityName && types.some(t => idSet.has(t))) entityName = nameOf(node);
    if (!hasContact && (node.email || node.telephone || node.address || node.contactPoint)) hasContact = true;

    if (Array.isArray(node['@graph'])) node['@graph'].forEach(walk);
    Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
  };
  blocks.forEach(walk);
  return { author, date, sameAs, entityName, hasContact };
}

/* ============================ HTML analysis ============================ */
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

function analyzeHtml(html, headers) {
  const hdr = headers || { xRobots: '', lastModified: '' };
  const jsonld = extractJsonLd(html);
  const types = allJsonLdTypes(jsonld);
  const hasIdentityType = IDENTITY_TYPES.some(t => types.has(t));
  const hasContentType = CONTENT_TYPES.some(t => types.has(t));
  const jsonLdFound = jsonld.found || 0;
  const jsonLdBroken = jsonLdFound > 0 && jsonld.length === 0;
  const hasFaqPage = types.has('faqpage');

  const facts = jsonLdFacts(jsonld);

  // --- Autoría ---
  const metaAuthor = (html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const relAuthor = /rel=["'][^"']*\bauthor\b[^"']*["']/i.test(html);
  const author = facts.author || metaAuthor || null;
  const authorStructured = !!facts.author;

  // --- Frescura ---
  const metaDate = (html.match(/<meta[^>]+(?:property|name)=["'](?:article:modified_time|article:published_time|last-modified|date)["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const timeTag = (html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1];
  const pageDate = facts.date || metaDate || timeTag || null;   // declarada en la página
  const date = pageDate || hdr.lastModified || null;            // ...o solo en la cabecera HTTP
  const dateFromHeader = !pageDate && !!hdr.lastModified;
  let dateAgeDays = null;
  if (date) {
    const parsedDate = new Date(date);
    if (!isNaN(parsedDate.getTime())) {
      dateAgeDays = Math.max(0, Math.round((Date.now() - parsedDate.getTime()) / 86400000));
    }
  }

  // --- Respuesta clara ---
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const h1Text = h1 ? stripTags(h1) : '';
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const descWords = metaDesc.trim() ? metaDesc.trim().split(/\s+/).length : 0;

  // --- Estructura semántica ---
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  const subCount = (html.match(/<h[23][\s>]/gi) || []).length;
  const hasLandmark = /<(main|article)[\s>]/i.test(html);

  // --- Contenido ---
  const bodyText = stripTags(html);
  const textLen = bodyText.length;
  const metrics = (bodyText.slice(0, 40000).match(MEASURABLE_RE) || []).length;
  const headingQ = (html.match(/<h[2-4][^>]*>\s*[^<]*\?\s*<\/h[2-4]>/gi) || []).length;

  // --- Indexabilidad / citabilidad (meta robots + cabecera X-Robots-Tag) ---
  const metaRobots = (html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const robotsDirectives = (metaRobots + ',' + hdr.xRobots).toLowerCase();
  const hasNoindex = /\bnoindex\b|\bnone\b/.test(robotsDirectives);
  const hasNosnippet = /\bnosnippet\b/.test(robotsDirectives);
  const maxSnippetM = robotsDirectives.match(/max-snippet\s*:\s*(-?\d+)/);
  const maxSnippet = maxSnippetM ? parseInt(maxSnippetM[1], 10) : null;

  // --- Entidad ---
  const hasContact = facts.hasContact || /mailto:|tel:\+?\d/i.test(html);

  return {
    hasIdentityType, hasContentType, hasFaqPage, jsonLdFound, jsonLdBroken,
    author, authorStructured, metaAuthor: !!metaAuthor, relAuthor,
    date, dateAgeDays, dateFromHeader,
    h1Text, descWords, h1Count, subCount, hasLandmark,
    textLen, metrics, headingQ,
    hasNoindex, hasNosnippet, maxSnippet,
    sameAs: facts.sameAs, entityName: facts.entityName, hasContact
  };
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
  aiFeatures: { url: 'https://developers.google.com/search/docs/appearance/ai-features',
    label: { es: 'Google · Funciones de IA y tu web', en: 'Google · AI features and your website' } },
  aiGuide: { url: 'https://developers.google.com/search/docs/fundamentals/ai-optimization-guide',
    label: { es: 'Google · Guía de optimización para IA generativa', en: 'Google · Guide to optimizing for generative AI' } },
  sitemaps: { url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview',
    label: { es: 'Google · Sitemaps', en: 'Google · Sitemaps' } },
  freshness: { url: 'https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search',
    label: { es: 'Microsoft Bing · Frescura en búsqueda con IA', en: 'Microsoft Bing · Freshness in AI-powered search' } },
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

function botLabels(ids) {
  return ids.map(id => (BOT_INFO[id] || { label: id }).label).join(', ');
}

/* Texto por-página del estado de cada dimensión (depende de lo detectado). */
function dimStatus(key, level, h) {
  const T = {
    /* ---------- Bloque ACCESO ---------- */
    aiAccess: {
      green:  { es: 'Tu robots.txt no bloquea a ningún motor de IA.',
                en: 'Your robots.txt does not block any AI engine.' },
      yellow: { es: `Bloqueas bots de entrenamiento (${botLabels(h.blockedTraining || [])}), pero los que te citan sí pueden leerte.`,
                en: `You block training bots (${botLabels(h.blockedTraining || [])}), but the ones that cite you can read you.` },
      red:    { es: `Tu robots.txt bloquea motores que deciden a quién citar: ${botLabels(h.blockedCitation || [])}.`,
                en: `Your robots.txt blocks engines that decide who gets cited: ${botLabels(h.blockedCitation || [])}.` }
    },
    indexable: {
      green:  { es: 'Esta página se puede indexar y mostrar con extracto: nada lo impide.',
                en: 'This page can be indexed and shown with a snippet: nothing blocks it.' },
      yellow: { es: `Limitas el extracto a ${h.maxSnippet} caracteres, muy poco para que la IA extraiga una respuesta.`,
                en: `You limit the snippet to ${h.maxSnippet} characters, too little for AI to extract an answer.` },
      red:    { es: h.hasNoindex
                  ? 'Esta página lleva "noindex": le estás pidiendo a los buscadores que no la muestren.'
                  : 'Esta página lleva "nosnippet" (o max-snippet:0): prohíbes que se muestre un extracto, y sin extracto no hay cita.',
                en: h.hasNoindex
                  ? 'This page carries "noindex": you are asking search engines not to show it.'
                  : 'This page carries "nosnippet" (or max-snippet:0): you forbid showing a snippet, and without a snippet there is no citation.' }
    },
    sitemap: {
      green:  { es: 'Tienes sitemap accesible y declarado en robots.txt.',
                en: 'You have a sitemap that is reachable and declared in robots.txt.' },
      yellow: { es: h.sitemapReachable
                  ? 'Tu sitemap existe pero no está declarado en robots.txt.'
                  : 'Declaras un sitemap en robots.txt pero no hemos podido leerlo.',
                en: h.sitemapReachable
                  ? 'Your sitemap exists but is not declared in robots.txt.'
                  : 'You declare a sitemap in robots.txt but we could not read it.' },
      red:    { es: 'No encontramos sitemap ni declarado en robots.txt ni en /sitemap.xml.',
                en: 'No sitemap found, neither declared in robots.txt nor at /sitemap.xml.' }
    },
    rendering: {
      green:  { es: `El texto está en el HTML sin ejecutar JavaScript (${h.textLen} caracteres).`,
                en: `The text is in the HTML without running JavaScript (${h.textLen} characters).` },
      yellow: { es: `Solo encontramos ${h.textLen} caracteres de texto en el HTML: puede que parte del contenido dependa de JavaScript.`,
                en: `We only found ${h.textLen} characters of text in the HTML: part of the content may depend on JavaScript.` },
      red:    { es: `El HTML llega casi vacío (${h.textLen} caracteres): tu contenido solo aparece tras ejecutar JavaScript.`,
                en: `The HTML arrives nearly empty (${h.textLen} characters): your content only appears after running JavaScript.` }
    },
    /* ---------- Bloque COMPRENSIÓN ---------- */
    schema: {
      green:  { es: 'Detectamos quién eres y qué es esta página en datos estructurados.',
                en: 'We detected who you are and what this page is, in structured data.' },
      yellow: { es: h.hasIdentityType
                  ? 'Declaras quién eres, pero no qué es esta página (Article, FAQPage, Service…).'
                  : 'Declaras qué es esta página, pero no quién eres (Organization o Person).',
                en: h.hasIdentityType
                  ? 'You declare who you are, but not what this page is (Article, FAQPage, Service…).'
                  : 'You declare what this page is, but not who you are (Organization or Person).' },
      red:    { es: h.jsonLdBroken
                  ? 'Hay datos estructurados en la página, pero tienen un error de sintaxis y no se pueden leer.'
                  : 'No detectamos datos estructurados en esta página.',
                en: h.jsonLdBroken
                  ? 'There is structured data on the page, but it has a syntax error and cannot be read.'
                  : 'No structured data detected on this page.' }
    },
    entity: {
      green:  { es: `Te identificas como "${h.entityName}" y enlazas ${h.sameAs} perfiles externos que lo confirman.`,
                en: `You identify as "${h.entityName}" and link ${h.sameAs} external profiles that confirm it.` },
      yellow: { es: `Te identificas como "${h.entityName}", pero apenas enlazas perfiles externos que lo respalden.`,
                en: `You identify as "${h.entityName}", but you barely link external profiles backing it up.` },
      red:    { es: 'No detectamos una entidad con nombre (empresa o persona) en los datos estructurados.',
                en: 'No named entity (company or person) detected in the structured data.' }
    },
    structure: {
      green:  { es: `Un solo H1, ${h.subCount} subtítulos y etiquetas semánticas: la página se lee bien por partes.`,
                en: `A single H1, ${h.subCount} subheadings and semantic tags: the page reads well in sections.` },
      yellow: (function () {
        const es = [], en = [];
        if (h.h1Count > 1) {
          es.push(`hay ${h.h1Count} etiquetas H1 y la IA no sabe cuál es el titular principal`);
          en.push(`there are ${h.h1Count} H1 tags and AI cannot tell which is the main headline`);
        }
        if (h.subCount < 3) {
          es.push(`solo hay ${h.subCount} subtítulo(s) H2/H3 para ordenar el texto`);
          en.push(`there are only ${h.subCount} H2/H3 subheading(s) organising the text`);
        }
        if (!h.hasLandmark) {
          es.push('falta envolver el contenido en <main> o <article>');
          en.push('the content is not wrapped in <main> or <article>');
        }
        return {
          es: 'Casi: ' + es.join('; ') + '.',
          en: 'Almost there: ' + en.join('; ') + '.'
        };
      })(),
      red:    { es: h.h1Count === 0
                  ? 'La página no tiene ningún H1: falta el titular principal.'
                  : 'La página no tiene subtítulos H2/H3: es un bloque de texto sin partes.',
                en: h.h1Count === 0
                  ? 'The page has no H1 at all: the main headline is missing.'
                  : 'The page has no H2/H3 subheadings: it is one block of text with no sections.' }
    },
    authorship: {
      green:  { es: `Detectamos autor en datos estructurados: ${h.author}.`,
                en: `Author detected in structured data: ${h.author}.` },
      yellow: { es: `Detectamos autor (${h.author}), pero solo como etiqueta suelta, no en datos estructurados.`,
                en: `Author detected (${h.author}), but only as a loose tag, not in structured data.` },
      red:    { es: 'No detectamos quién firma esta página.',
                en: 'We could not detect who signs this page.' }
    },
    /* ---------- Bloque CONTENIDO CITABLE ---------- */
    answer: {
      green:  { es: 'La página abre con un titular claro y un resumen corto.',
                en: 'The page opens with a clear headline and a short summary.' },
      yellow: { es: 'Tienes titular o resumen corto, pero no ambos.',
                en: 'You have a headline or a short summary, but not both.' },
      red:    { es: 'La página no abre con titular claro y resumen corto.',
                en: 'The page does not open with a clear headline and short summary.' }
    },
    metrics: {
      green:  { es: `Detectamos ${h.metrics} cifras verificables.`, en: `${h.metrics} verifiable figures detected.` },
      yellow: { es: `Detectamos ${h.metrics} cifra(s); añade más.`, en: `${h.metrics} figure(s) detected; add more.` },
      red:    { es: 'No detectamos cifras verificables en esta página.', en: 'No verifiable figures detected on this page.' }
    },
    faq: {
      green:  { es: 'Tienes una FAQ con datos estructurados (FAQPage).', en: 'You have an FAQ with structured data (FAQPage).' },
      yellow: { es: 'Tienes preguntas, pero sin datos estructurados (FAQPage).', en: 'You have questions, but no structured data (FAQPage).' },
      red:    { es: 'No detectamos preguntas frecuentes en esta página.', en: 'No FAQ detected on this page.' }
    },
    freshness: {
      green:  { es: `La página declara que se actualizó hace ${h.dateAgeDays} días.`,
                en: `The page states it was updated ${h.dateAgeDays} days ago.` },
      yellow: { es: h.dateFromHeader
                  ? 'La única fecha que encontramos es la cabecera del servidor, que en hosting estático cambia en cada despliegue. La página en sí no declara cuándo se actualizó.'
                  : h.dateAgeDays === null
                    ? 'Hay una fecha en la página, pero no la hemos podido interpretar.'
                    : `La última actualización declarada es de hace ${Math.round(h.dateAgeDays / 30)} meses.`,
                en: h.dateFromHeader
                  ? 'The only date we found is the server header, which on static hosting changes with every deploy. The page itself does not declare when it was updated.'
                  : h.dateAgeDays === null
                    ? 'There is a date on the page, but we could not interpret it.'
                    : `The last declared update is ${Math.round(h.dateAgeDays / 30)} months old.` },
      red:    { es: 'La página no dice en ninguna parte cuándo se actualizó por última vez.',
                en: 'The page does not say anywhere when it was last updated.' }
    }
  };
  return T[key][level];
}

/* ============================ Analysis → dimensions + blocks + index ============================ */
function lvlScore(level) { return level === 'green' ? 90 : level === 'yellow' ? 55 : 20; }
function scoreLevel(score) { return score > 70 ? 'green' : score > 40 ? 'yellow' : 'red'; }

const FRESH_DAYS = 365;

function analyze({ url, html, headers, robotsTxt, hasLlms, sitemapReachable }) {
  const robots = parseRobots(robotsTxt);
  const h = analyzeHtml(html, headers);

  // Datos de robots/sitemap que dimStatus también necesita.
  h.blockedCitation = robots.blockedCitation;
  h.blockedTraining = robots.blockedTraining;
  h.sitemapReachable = !!sitemapReachable;
  const sitemapDeclared = robots.sitemaps.length > 0;

  /* ---------- Bloque ACCESO ---------- */
  const aiAccessLevel = robots.blockedCitation.length ? 'red'
    : robots.blockedTraining.length ? 'yellow' : 'green';

  const indexableLevel = (h.hasNoindex || h.hasNosnippet || h.maxSnippet === 0) ? 'red'
    : (h.maxSnippet !== null && h.maxSnippet > 0 && h.maxSnippet < 50) ? 'yellow' : 'green';

  const sitemapLevel = (sitemapDeclared && h.sitemapReachable) ? 'green'
    : (sitemapDeclared || h.sitemapReachable) ? 'yellow' : 'red';

  const renderingLevel = h.textLen >= 1500 ? 'green' : h.textLen >= 400 ? 'yellow' : 'red';

  /* ---------- Bloque COMPRENSIÓN ---------- */
  const schemaLevel = (h.hasIdentityType && h.hasContentType) ? 'green'
    : (h.hasIdentityType || h.hasContentType) ? 'yellow' : 'red';

  const entityLevel = (h.entityName && h.sameAs >= 2) ? 'green'
    : (h.entityName && (h.sameAs >= 1 || h.hasContact)) ? 'yellow' : 'red';

  const structureLevel = (h.h1Count === 0 || h.subCount === 0) ? 'red'
    : (h.h1Count === 1 && h.subCount >= 3 && h.hasLandmark) ? 'green' : 'yellow';

  const authLevel = h.authorStructured ? 'green' : h.author ? 'yellow' : 'red';

  /* ---------- Bloque CONTENIDO CITABLE ---------- */
  const h1ok = h.h1Text && h.h1Text.length > 8;
  const shortSummary = h.descWords > 0 && h.descWords <= 40;
  const answerLevel = (h1ok && shortSummary) ? 'green' : (h1ok || shortSummary) ? 'yellow' : 'red';

  const metricLevel = h.metrics >= 3 ? 'green' : h.metrics >= 1 ? 'yellow' : 'red';

  const faqLevel = h.hasFaqPage ? 'green' : h.headingQ >= 3 ? 'yellow' : 'red';

  // Verde solo si la propia página declara una fecha reciente. Si la única pista es la
  // cabecera Last-Modified del servidor, es ámbar: en hosting estático refleja el último
  // despliegue, no que el contenido se haya revisado.
  const freshLevel = !h.date ? 'red'
    : (!h.dateFromHeader && h.dateAgeDays !== null && h.dateAgeDays <= FRESH_DAYS) ? 'green' : 'yellow';

  // section = paso del constructor que lo arregla (todos existen ya).
  const defs = [
    { key: 'aiAccess',   block: 'access',        level: aiAccessLevel,  section: 'crawlers', source: SOURCES.gptbot },
    { key: 'indexable',  block: 'access',        level: indexableLevel, section: 'crawlers', source: SOURCES.aiFeatures },
    { key: 'sitemap',    block: 'access',        level: sitemapLevel,   section: 'crawlers', source: SOURCES.sitemaps },
    { key: 'rendering',  block: 'access',        level: renderingLevel, section: 'crawlers', source: SOURCES.aiGuide },

    { key: 'schema',     block: 'understanding', level: schemaLevel,    section: 'eeat',     source: SOURCES.schema },
    { key: 'entity',     block: 'understanding', level: entityLevel,    section: 'eeat',     source: SOURCES.eeat },
    { key: 'structure',  block: 'understanding', level: structureLevel, section: 'zerozone', source: SOURCES.aiGuide },
    { key: 'authorship', block: 'understanding', level: authLevel,      section: 'eeat',     source: SOURCES.eeat },

    { key: 'answer',     block: 'content',       level: answerLevel,    section: 'zerozone', source: SOURCES.eeat },
    { key: 'metrics',    block: 'content',       level: metricLevel,    section: 'causal',   source: SOURCES.eeat },
    { key: 'faq',        block: 'content',       level: faqLevel,       section: 'faqs',     source: SOURCES.schema },
    { key: 'freshness',  block: 'content',       level: freshLevel,     section: 'eeat',     source: SOURCES.freshness }
  ];
  const dimensions = defs.map(d => ({
    key: d.key, block: d.block, level: d.level, section: d.section,
    status: dimStatus(d.key, d.level, h),
    source: { label: d.source.label, url: d.source.url }
  }));

  // Cada bloque vale un tercio. Dentro del bloque, sus señales pesan igual.
  const BLOCK_KEYS = ['access', 'understanding', 'content'];
  const blocks = BLOCK_KEYS.map(bk => {
    const dims = dimensions.filter(d => d.block === bk);
    const score = Math.round(dims.reduce((sum, d) => sum + lvlScore(d.level), 0) / dims.length);
    return { key: bk, score, level: scoreLevel(score) };
  });
  const idx = Math.round(blocks.reduce((sum, b) => sum + b.score, 0) / blocks.length);

  let scores;
  if (robots.blockedCitation.length) {
    // Solo los bots de citación disparan el estado "Invisible para la IA".
    // Bloquear únicamente bots de entrenamiento es una decisión legítima: sale ámbar, no alarma.
    const blockedBots = robots.blockedCitation.map(id => {
      const info = BOT_INFO[id] || { label: id, src: null };
      return { label: info.label, url: info.src ? SOURCES[info.src].url : null };
    });
    scores = { index: null, band: 'invisible', blocked: true, blockedBots };
  } else {
    const band = idx <= 40 ? 'critical' : idx <= 70 ? 'improvable' : 'good';
    scores = { index: idx, band, blocked: false };
  }

  return { url, scores, blocks, dimensions, llmsMissing: !hasLlms };
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
function isSitemapBody(txt) {
  return !!(txt && /<(urlset|sitemapindex)[\s>]/i.test(txt));
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
  const [htmlRes, robotsRes, llmsRes, sitemapRes] = await Promise.all([
    fetchText(parsed.href, ua),
    fetchText(origin + '/robots.txt', ua),
    fetchText(origin + '/llms.txt', ua),
    fetchText(origin + '/sitemap.xml', ua)
  ]);

  if (!htmlRes.ok || !htmlRes.text) {
    // timeout, DNS failure, 4xx/5xx, or the site blocks our bot
    return json({ ok: false, error: 'fetch_failed' });
  }

  const robotsTxt = robotsRes.ok ? robotsRes.text : '';

  // Si /sitemap.xml no responde pero robots.txt declara otro, probamos ese (una sola vez).
  let sitemapReachable = sitemapRes.ok && isSitemapBody(sitemapRes.text);
  if (!sitemapReachable) {
    const declared = parseRobots(robotsTxt).sitemaps[0];
    if (declared && declared !== origin + '/sitemap.xml') {
      const alt = await fetchText(declared, ua);
      sitemapReachable = alt.ok && isSitemapBody(alt.text);
    }
  }

  try {
    const result = analyze({
      url: parsed.href,
      html: htmlRes.text,
      headers: htmlRes.headers,
      robotsTxt: robotsTxt,
      hasLlms: !!(llmsRes.ok && llmsRes.text && llmsRes.text.trim()),
      sitemapReachable: sitemapReachable
    });
    const data = extractAutofill(htmlRes.text, robotsTxt, parsed);
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
export const __test = { parseRobots, analyzeHtml, analyze, normalizeUrl, dimStatus, extractAutofill, CITATION_BOTS, TRAINING_BOTS };
