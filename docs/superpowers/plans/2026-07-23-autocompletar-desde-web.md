# Autocompletar desde mi web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que al pulsar "Autocompletar desde mi web" en `1009.html`, el backend `audit.js` (que ya crawlea) devuelva los datos crudos del sitio y el frontend rellene solos los campos vacíos del constructor, marcándolos como "sugerido".

**Architecture:** El backend ya descarga HTML + robots.txt y ya extrae JSON-LD/FAQPage/h1. Se añade un objeto `data` (crudo) a la respuesta JSON, sin tocar `scores`/`findings`. El frontend añade un campo "Sitio web" + botón, llama al mismo `/api/audit`, y con `data` rellena solo los campos vacíos.

**Tech Stack:** HTML/CSS/JS vanilla (un solo archivo `1009.html`) + Cloudflare Pages Function (`functions/api/audit.js`). Sin build, sin framework, sin runner de tests. Verificación real con `curl` y `npx wrangler pages dev .`.

## Global Constraints

- No romper: autoguardado (`localStorage`), exports, ni el flujo de construcción existente.
- Todo texto nuevo traducido a **ES y EN** en el objeto `T` (claves en `T.es` y `T.en`).
- Cambios solo en `1009.html` + `functions/api/audit.js`. `index.html` público **no se toca**.
- `scores` y `findings` de la respuesta del audit **no cambian** (retrocompatible).
- Backend: reutilizar el HTML/robots.txt ya descargados; no añadir fetches nuevos.
- Rellenar **solo campos vacíos**; nunca sobrescribir lo que el usuario ya escribió.
- Backend base: `window.AUDIT_API_BASE = 'https://radar.sarauter.com'` (verificado alcanzable, CORS `*`).
- Deploy: el usuario sube los archivos por la web de GitHub → Cloudflare redespliega solo. No hay `git push`.

---

## File Structure

- `functions/api/audit.js` — MODIFICAR: añadir extractores de autofill + objeto `data` en la respuesta.
- `1009.html` — MODIFICAR: campo "Sitio web" + botón, estado (`brand.website`, `suggested`), funciones `autofillFromWeb()` / `applyAutofill()`, CSS `.suggested`, e i18n.

---

### Task 1: Backend — devolver datos crudos para autocompletar (`data`)

**Files:**
- Modify: `functions/api/audit.js` (añadir funciones tras `analyzeHtml`, y merge de `data` en `onRequestPost`)

**Interfaces:**
- Produces: la respuesta JSON de `POST /api/audit` gana una clave `data` con esta forma exacta:
  ```
  data: {
    website: string,      // ej. "https://sarauter.com/"
    domain: string,       // ej. "sarauter.com"
    robotsText: string,   // texto crudo del robots.txt ('' si no hay)
    metaNoindex: 'si'|'no',
    jsRendered: 'si'|'no'|'unsure',
    brandName: string,    // '' si no se detecta
    description: string,  // '' si no se detecta
    h1: string,           // '' si no se detecta
    faqs: [ { question: string, answer: string }, ... ]   // [] si no hay FAQPage
  }
  ```
  El frontend (Task 2) consume `data.data`.

- [ ] **Step 1: Añadir las funciones de extracción** justo después de la función `analyzeHtml(html)` (busca la línea `return { hasOrg, hasArticle, hasFaqPage, author, date, sameAs, h1Text, descWords, metrics, headingQ };` y su `}` de cierre). Pega este bloque a continuación:

```js
/* ============================ Autofill extraction ============================ */
function firstMatch(re, s) { const m = (s || '').match(re); return m ? m[1] : ''; }

function extractFaqPairs(blocks) {
  const pairs = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const types = node['@type'] ? (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) : [];
    if (types.map(t => String(t).toLowerCase()).indexOf('question') >= 0) {
      const q = (node.name || '').toString().trim();
      const ans = node.acceptedAnswer;
      let a = ans ? (typeof ans === 'string' ? ans : (ans.text || (Array.isArray(ans) && ans[0] && ans[0].text) || '')) : '';
      a = stripTags(String(a)).trim();
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
  const ogSite = firstMatch(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i, html);
  let title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  title = stripTags(title).replace(/\s*[|–—\-]\s[\s\S]*$/, '').trim();
  const brandName = (ogSite || title || '').trim();

  const metaDesc = firstMatch(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i, html);
  const ogDesc = firstMatch(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i, html);
  const description = (metaDesc || ogDesc || '').trim();

  const h1raw = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const h1 = h1raw ? stripTags(h1raw).trim() : '';

  const robotsMeta = firstMatch(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i, html);
  const metaNoindex = /noindex/i.test(robotsMeta) ? 'si' : 'no';

  const bodyText = stripTags(html);
  const jsRendered = bodyText.length > 600 ? 'si' : (bodyText.length < 150 ? 'no' : 'unsure');

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
```

- [ ] **Step 2: Incluir `data` en la respuesta.** En `onRequestPost`, localiza el bloque `try { const result = analyze({ ... }); return json(Object.assign({ ok: true }, result)); }`. Sustituye la línea del `return` para que quede así:

```js
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
```

- [ ] **Step 3: Arrancar el servidor local** (desde la raíz del proyecto):

Run: `npx wrangler pages dev . --port 8788`
Expected: arranca y muestra `Ready on http://localhost:8788`.

- [ ] **Step 4: Verificar que `data` llega y trae los campos.**

Run:
```bash
curl -s -X POST http://localhost:8788/api/audit -H "Content-Type: application/json" -d '{"url":"sarauter.com"}' | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('KEYS:', sorted(d.keys())); print('domain=',d['domain'],'| noindex=',d['metaNoindex'],'| js=',d['jsRendered']); print('brandName=',repr(d['brandName'])[:70]); print('desc=',repr(d['description'])[:70]); print('h1=',repr(d['h1'])[:70]); print('robots_len=',len(d['robotsText']),'| faqs=',len(d['faqs']))"
```
Expected: imprime `KEYS: ['brandName', 'description', 'domain', 'faqs', 'h1', 'jsRendered', 'metaNoindex', 'robotsText', 'website']`, con `domain=sarauter.com`, `metaNoindex` = `si` o `no`, `js` = `si`/`no`/`unsure`, y `robots_len` > 0.

- [ ] **Step 5: Verificar retrocompatibilidad** (scores/findings intactos).

Run:
```bash
curl -s -X POST http://localhost:8788/api/audit -H "Content-Type: application/json" -d '{"url":"sarauter.com"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok=',d['ok'],'| scores=',d['scores'],'| findings=',len(d['findings']))"
```
Expected: `ok= True`, `scores` con content/distribution/geo numéricos, `findings` ≥ 1.

- [ ] **Step 6: Verificar URL inválida** (no debe romper).

Run: `curl -s -X POST http://localhost:8788/api/audit -H "Content-Type: application/json" -d '{"url":"no-es-un-dominio"}'`
Expected: `{"ok":false,"error":"invalid_url"}` (sin `data`).

---

### Task 2: Frontend — campo "Sitio web", botón y autocompletado

**Files:**
- Modify: `1009.html` (CSS, HTML del paso Marca, estado, funciones nuevas, i18n)

**Interfaces:**
- Consumes: `data.data` de `POST /api/audit` (Task 1). Reutiliza funciones ya existentes en el archivo: `auditEndpoint()`, `escapeHtml()`, `t()`, `bindCrawlers()`, `renderPages()`, `renderFaqRows()`, `saveState()`, `refreshNavDots()`, `renderDashboard()`.
- Produces: funciones globales `autofillFromWeb()` (onclick del botón) y `applyAutofill(d)`.

- [ ] **Step 1: Añadir el CSS del estado "sugerido".** Busca en el bloque `<style>` la regla `.audit-status.err{` y pega esta regla justo antes de ella:

```css
input.suggested, textarea.suggested, select.suggested{ border-color:var(--purple-400); background:#f3f0fb; box-shadow:0 0 0 3px rgba(94,94,138,.10); }
.af-summary{ margin-top:12px; }
```

- [ ] **Step 2: Añadir el campo "Sitio web" + botón** en el paso Marca. Busca la línea que abre la tarjeta del paso marca — el primer `<div class="grid2">` que está dentro de `<section class="step-panel" id="step-brand">` (justo después de `<div class="card">`). Inserta este bloque **inmediatamente después** de `<div class="card">` y **antes** de ese `<div class="grid2">`:

```html
        <div class="field">
          <label data-i18n="brandWebsiteLabel">Sitio web</label>
          <span class="help" data-i18n="brandWebsiteHelp">Pega la URL de tu web y la herramienta rellenará sola lo que pueda leer de ella. Solo rellena campos vacíos; no pisa lo que ya escribiste.</span>
          <div class="chip-input-row">
            <input type="url" id="brandWebsite" inputmode="url" autocomplete="url" data-i18n-ph="brandWebsitePh" onkeydown="if(event.key==='Enter'){event.preventDefault();autofillFromWeb();}">
            <button class="btn btn-accent btn-sm" id="autofillBtn" onclick="autofillFromWeb()" data-i18n="autofillBtn">⚡ Autocompletar desde mi web</button>
          </div>
          <div id="autofillStatus" class="audit-status" style="display:none;"></div>
          <div id="autofillSummary" class="af-summary"></div>
        </div>
```

- [ ] **Step 3: Añadir `website` y `suggested` al estado.** En `function defaultState()`, localiza la línea `brand:{ name:'', category:'', description:'', intent:'comercial', adjacent:[], infoGain:'', differentiators:[], competitors:[], budgetTiers:[] },` y sustitúyela por (añade `website:''`):

```js
    brand:{ name:'', category:'', description:'', intent:'comercial', adjacent:[], infoGain:'', differentiators:[], competitors:[], budgetTiers:[], website:'' },
```

En ese mismo objeto `defaultState`, localiza la línea `unlocked:false` (última propiedad) y añade `suggested:{}` — cambia `unlocked:false` por:

```js
    unlocked:false,
    suggested:{}
```

- [ ] **Step 4: Normalizar `suggested` al cargar.** En `function normalizeState()`, tras la línea `if(typeof state.unlocked!=='boolean') state.unlocked = false;`, añade:

```js
  if(!state.suggested || typeof state.suggested!=='object') state.suggested = {};
```

- [ ] **Step 5: Bindear el campo `brandWebsite`.** En `function bindBrandFields()`, tras el listener de `brandDescription`, añade:

```js
  document.getElementById('brandWebsite').addEventListener('input', function(e){ state.brand.website=e.target.value; e.target.classList.remove('suggested'); saveState(); });
```

Y para que "sugerido" se limpie al editar nombre/descripción, sustituye las dos líneas existentes de `brandName` y `brandDescription` dentro de `bindBrandFields` por estas (añaden `classList.remove('suggested')`):

```js
  document.getElementById('brandName').addEventListener('input', function(e){ state.brand.name=e.target.value; e.target.classList.remove('suggested'); saveState(); });
  document.getElementById('brandCategory').addEventListener('input', function(e){ state.brand.category=e.target.value; saveState(); });
  document.getElementById('brandDescription').addEventListener('input', function(e){ state.brand.description=e.target.value; e.target.classList.remove('suggested'); saveState(); });
```

- [ ] **Step 6: Mostrar el valor guardado de `brandWebsite` al iniciar.** En `function renderInit()`, tras la línea `document.getElementById('brandDescription').value = state.brand.description;`, añade:

```js
  document.getElementById('brandWebsite').value = state.brand.website || '';
```

- [ ] **Step 7: Limpiar "sugerido" al editar los campos de crawlers.** En `function onCrawlersInput()`, al principio de la función (antes de leer los valores), añade:

```js
  ['crawlerDomain','robotsTextInput','jsRenderedSelect','metaNoindexSelect'].forEach(function(id){ var el=document.getElementById(id); if(el) el.classList.remove('suggested'); });
```

- [ ] **Step 8: Añadir las funciones de autocompletado.** Busca la función `function fixFinding(section){` y pega **justo antes** de ella este bloque:

```js
function setAutofillStatus(kind, msg){
  var el = document.getElementById('autofillStatus'); if(!el) return;
  el.style.display = 'block';
  el.className = 'audit-status ' + kind;
  el.innerHTML = (kind==='loading' ? '<span class="audit-spinner"></span>' : '') + escapeHtml(msg);
}
function clearAutofillStatus(){ var el=document.getElementById('autofillStatus'); if(el){ el.style.display='none'; el.innerHTML=''; } }
async function autofillFromWeb(){
  var input = document.getElementById('brandWebsite');
  var url = (input && input.value || '').trim();
  if(!url){ if(input) input.focus(); setAutofillStatus('err', t('autofillErrUrl')); return; }
  state.brand.website = url; saveState();
  document.getElementById('autofillSummary').innerHTML = '';
  setAutofillStatus('loading', t('autofillLoading'));
  var btn = document.getElementById('autofillBtn'); if(btn) btn.disabled = true;
  try{
    var res = await fetch(auditEndpoint(), {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ url: url })
    });
    var ct = res.headers.get('content-type') || '';
    if(ct.indexOf('application/json') < 0){ setAutofillStatus('err', t('auditErrNoApi')); return; }
    var data = await res.json();
    if(!data.ok || !data.data){
      var msg = data.error==='invalid_url' ? t('auditErrInvalid')
              : data.error==='fetch_failed' ? t('auditErrFetch') : t('auditErrGeneric');
      setAutofillStatus('err', msg); return;
    }
    clearAutofillStatus();
    applyAutofill(data.data);
  }catch(e){
    setAutofillStatus('err', t('auditErrNoApi'));
  }finally{
    if(btn) btn.disabled = false;
  }
}
function markSuggested(elId, key){
  state.suggested[key] = true;
  var el = document.getElementById(elId);
  if(el) el.classList.add('suggested');
}
function applyAutofill(d){
  var filled = [], skipped = [];
  // Brand name
  if(d.brandName && !state.brand.name.trim()){
    state.brand.name = d.brandName;
    var bn = document.getElementById('brandName'); if(bn) bn.value = d.brandName;
    markSuggested('brandName','brandName'); filled.push(t('afBrandName'));
  }
  // Description
  if(d.description && !state.brand.description.trim()){
    state.brand.description = d.description;
    var bd = document.getElementById('brandDescription'); if(bd) bd.value = d.description;
    markSuggested('brandDescription','brandDescription'); filled.push(t('afDescription'));
  }
  // Crawlers: domain
  if(d.domain && !state.crawlers.domain.trim()){
    state.crawlers.domain = d.domain; filled.push(t('afDomain'));
    state.suggested.crawlerDomain = true;
  }
  // Crawlers: robots.txt
  if(d.robotsText && !state.crawlers.robotsText.trim()){
    state.crawlers.robotsText = d.robotsText; filled.push(t('afRobots'));
    state.suggested.robotsTextInput = true;
  }
  // Crawlers: meta noindex (only if still unsure)
  if(d.metaNoindex && state.crawlers.metaNoindex==='unsure'){
    state.crawlers.metaNoindex = d.metaNoindex; filled.push(t('afNoindex'));
    state.suggested.metaNoindexSelect = true;
  }
  // Crawlers: js-rendered (only if still unsure)
  if(d.jsRendered && state.crawlers.jsRendered==='unsure'){
    state.crawlers.jsRendered = d.jsRendered; filled.push(t('afJs'));
    state.suggested.jsRenderedSelect = true;
  }
  // Page 0 H1
  var p0 = state.pages[0];
  if(d.h1 && p0 && !p0.h1.trim()){
    p0.h1 = d.h1; filled.push(t('afH1'));
  }
  // FAQs (only if none filled yet)
  var faqEmpty = !state.faqs.some(function(f){ return (f.question||'').trim() && (f.answer||'').trim(); });
  if(d.faqs && d.faqs.length && faqEmpty){
    state.faqs = d.faqs.slice(0,8).map(function(f){ return { type:'definicion', question:f.question, answer:f.answer }; });
    filled.push(d.faqs.length + ' FAQs');
  } else if(d.faqs && !d.faqs.length){
    skipped.push(t('afNoFaq'));
  }
  // Refresh dependent UI (all step panels exist in the DOM, just hidden)
  bindCrawlers();
  ['crawlerDomain','robotsTextInput','jsRenderedSelect','metaNoindexSelect'].forEach(function(id){
    if(state.suggested[id]){ var el=document.getElementById(id); if(el) el.classList.add('suggested'); }
  });
  renderPages();
  renderFaqRows();
  saveState();
  refreshNavDots();
  renderDashboard();
  renderAutofillSummary(filled, skipped, d);
}
function renderAutofillSummary(filled, skipped, d){
  var host = document.getElementById('autofillSummary');
  if(!host) return;
  if(!filled.length){
    host.innerHTML = '<div class="audit-status err" style="display:block;">'+escapeHtml(t('afNothing'))+'</div>';
    return;
  }
  var title = t('afDoneTitle').replace('%N%', filled.length).replace('%D%', escapeHtml(d.domain||''));
  var html = '<div class="callout soft"><b>'+title+'</b><br>'+filled.map(escapeHtml).join(' · ');
  if(skipped.length) html += '<br><span style="opacity:.75;">'+skipped.map(escapeHtml).join(' · ')+'</span>';
  html += '<br><span style="opacity:.75;">'+escapeHtml(t('afReview'))+'</span></div>';
  host.innerHTML = html;
}
```

- [ ] **Step 9: Añadir las claves i18n en ESPAÑOL.** En el objeto `T.es`, tras la clave `brandNamePh:` (o cualquier clave de marca), añade:

```js
  brandWebsiteLabel:"Sitio web",
  brandWebsitePh:"Ej. tuempresa.com",
  brandWebsiteHelp:"Pega la URL de tu web y la herramienta rellenará sola lo que pueda leer de ella. Solo rellena campos vacíos; no pisa lo que ya escribiste.",
  autofillBtn:"⚡ Autocompletar desde mi web",
  autofillLoading:"Leyendo tu web… esto tarda unos segundos.",
  autofillErrUrl:"Escribe la URL de tu web, p. ej. tuempresa.com.",
  afBrandName:"Nombre de marca",
  afDescription:"Descripción",
  afDomain:"Dominio",
  afRobots:"robots.txt",
  afNoindex:"Meta noindex",
  afJs:"Contenido sin JS",
  afH1:"H1 de la home",
  afNoFaq:"La web no tiene FAQ estructurada (FAQPage): rellénalas a mano.",
  afDoneTitle:"Rellené %N% campo(s) desde %D%.",
  afReview:"Revisa los campos marcados en morado antes de continuar.",
  afNothing:"No pude rellenar nada nuevo: o no lo detecté en la web, o esos campos ya tenían contenido.",
```

- [ ] **Step 10: Añadir las claves i18n en INGLÉS.** En el objeto `T.en`, en el mismo sitio relativo (tras `brandNamePh:`), añade:

```js
  brandWebsiteLabel:"Website",
  brandWebsitePh:"E.g. yourcompany.com",
  brandWebsiteHelp:"Paste your website URL and the tool will auto-fill whatever it can read from it. It only fills empty fields; it never overwrites what you already wrote.",
  autofillBtn:"⚡ Auto-fill from my website",
  autofillLoading:"Reading your website… this takes a few seconds.",
  autofillErrUrl:"Enter your website URL, e.g. yourcompany.com.",
  afBrandName:"Brand name",
  afDescription:"Description",
  afDomain:"Domain",
  afRobots:"robots.txt",
  afNoindex:"Meta noindex",
  afJs:"Content without JS",
  afH1:"Home H1",
  afNoFaq:"The site has no structured FAQ (FAQPage): fill them in manually.",
  afDoneTitle:"Filled %N% field(s) from %D%.",
  afReview:"Review the fields highlighted in purple before continuing.",
  afNothing:"Nothing new to fill: either I didn't detect it on the site, or those fields already had content.",
```

- [ ] **Step 11: Apuntar el frontend al backend LOCAL para probar.** Localiza `window.AUDIT_API_BASE = 'https://radar.sarauter.com';` y cámbialo **temporalmente** a:

```html
<script>window.AUDIT_API_BASE = '';</script>
```
(Así el fetch va a la función local de wrangler. Se revierte en el Step 16.)

- [ ] **Step 12: Arrancar el servidor local.**

Run: `npx wrangler pages dev . --port 8788`
Expected: `Ready on http://localhost:8788`.

- [ ] **Step 13: Abrir la herramienta y comprobar consola.** Abre `http://localhost:8788/1009.html` en el navegador (login: ver las constantes `RADAR_USER`/`RADAR_PASS` en `1009.html`). Ve al paso "Marca y empresa". Verifica que aparece el campo "Sitio web" con el botón "⚡ Autocompletar desde mi web", y que la consola del navegador no tiene errores.
Expected: campo y botón visibles; consola sin errores.

- [ ] **Step 14: Probar el autocompletado en vivo.** En el campo "Sitio web" escribe `sarauter.com` y pulsa el botón.
Expected: aparece el spinner "Leyendo tu web…", y al terminar (unos segundos) un resumen morado "Rellené N campo(s) desde sarauter.com" listando los campos. El campo "Nombre de marca" y "Descripción" quedan rellenos y con borde morado (clase `suggested`). Al ir al paso "Acceso de Crawlers IA", el `robots.txt` y el dominio están rellenos.

- [ ] **Step 15: Probar que NO pisa datos existentes.** Recarga, escribe a mano un "Nombre de marca" (ej. "PRUEBA"), luego pon `sarauter.com` y pulsa autocompletar.
Expected: "Nombre de marca" sigue siendo "PRUEBA" (no se sobrescribe); el resumen no lista "Nombre de marca" entre los rellenados. Al editar un campo morado, el borde morado desaparece.

- [ ] **Step 16: Revertir el `AUDIT_API_BASE` a producción.** Vuelve a dejar:

```html
<script>window.AUDIT_API_BASE = 'https://radar.sarauter.com';</script>
```

- [ ] **Step 17: Verificación final de idioma.** Con el server aún arrancado, recarga, cambia a EN y confirma que el label es "Website" y el botón "⚡ Auto-fill from my website". Vuelve a ES.
Expected: textos correctos en ambos idiomas, sin claves crudas visibles (nada tipo `autofillBtn`).

---

## Deploy (manual, lo hace el usuario)

Tras aprobar los cambios, subir a GitHub por la web (**Add file → Upload files**) exactamente estos dos archivos modificados:
- `1009.html`
- `functions/api/audit.js`

Cloudflare Pages redespliega solo. La auditoría/autocompletado usará `radar.sarauter.com` (ya verificado alcanzable). No subir `node_modules`, `.dev.vars` ni `.wrangler`.

---

## Self-Review

- **Cobertura del spec:** campo "Sitio web" (Task 2 Step 2) ✓; solo rellena vacíos (applyAutofill usa `!...trim()`) ✓; marca "sugerido" + limpia al editar (Steps 1,5,7,8) ✓; resumen de lo rellenado/omitido (renderAutofillSummary) ✓; campos técnicos + contenido básico (domain, robots, noindex, jsRendered, brandName, description, h1, faqs) ✓; backend retrocompatible (`data` añadido, scores/findings intactos — Task 1 Step 2) ✓; ES/EN (Steps 9-10) ✓; solo `1009.html` + `audit.js` ✓; riesgo backend verificado (endpoint alcanzable) ✓.
- **Sin placeholders:** todo el código está completo; sin TBD/TODO.
- **Consistencia de tipos:** `data.faqs` = `[{question,answer}]` producido en Task 1 y consumido idéntico en Task 2. `metaNoindex`/`jsRendered` usan `'si'|'no'|'unsure'`, que coinciden con los `value` de los `<select>` del paso crawlers. Funciones globales (`autofillFromWeb`, `applyAutofill`, `renderAutofillSummary`, `markSuggested`, `setAutofillStatus`, `clearAutofillStatus`) definidas una vez y referenciadas coherentemente.
