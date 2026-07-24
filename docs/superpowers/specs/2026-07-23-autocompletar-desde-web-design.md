# Diseño: "Autocompletar desde mi web" (RADAR / 1009.html)

**Fecha:** 2026-07-23
**Estado:** Aprobado (diseño) — pendiente de plan de implementación
**Archivos afectados:** `1009.html` (herramienta privada) + `functions/api/audit.js` (backend Cloudflare). `index.html` público **no se toca**.

## Problema

El constructor de `1009.html` hay que rellenarlo 100% a mano. Eso lo convierte en una
plantilla, no en un asistente. El ejemplo más sangrante: el paso "Acceso de Crawlers IA"
pide al usuario ir a `tudominio.com/robots.txt`, copiar el texto y pegarlo. Nadie va a hacer eso.

## Objetivo

Que la herramienta, a partir de la URL del sitio de la empresa, **llame a la web y rellene
sola todos los campos que le sea posible**, dejando al usuario solo pulir lo que la máquina
no puede saber. UX-friendly e intuitiva.

## Punto de partida (lo que YA existe)

`functions/api/audit.js` ya corre en servidor (sin límites CORS) y ya:
- Descarga HTML de la home, `robots.txt`, `/llms.txt` y sitemap (`Promise.all`, línea ~332).
- Extrae JSON-LD (`extractJsonLd`), detecta `FAQPage`/`Organization`/`Article`, saca `<h1>`,
  autor, fecha, `sameAs`, nº de palabras de descripción, etc. (`heuristics`, línea ~172).
- Con todo eso calcula `scores` y `findings` — **y descarta los datos crudos**.

Conclusión: el crawler no hay que construirlo. Hay que **devolver los datos crudos y bajarlos
a los campos del constructor**.

## Alcance elegido: técnico + contenido básico

### Campos que SÍ se autocompletan

| Campo (state) | Origen | Fiabilidad |
|---|---|---|
| `crawlers.domain` | host de la URL | Alta |
| `crawlers.robotsText` | robots.txt ya descargado por el backend | Alta |
| `crawlers.metaNoindex` (`yes`/`no`) | `<meta name="robots" content="...noindex...">` en `<head>` | Alta |
| `crawlers.jsRendered` (`yes`/`no`/`unsure`) | heurística: ¿hay texto visible real en el HTML crudo? | Media |
| `brand.name` | `og:site_name` → si no, `<title>` limpio (quita " \| tagline") | Media-Alta |
| `brand.description` | `meta description` → si no, `og:description` | Media-Alta |
| `pages[0].h1` | primer `<h1>` | Media-Alta |
| `pages[0].resumen` | `meta description` como borrador (marcado sugerido) | Media |
| `faqs[]` | pares pregunta/respuesta del schema `FAQPage` (JSON-LD) si existe | Alta si existe |

### Campos que NO se tocan (demasiado inciertos — siguen siendo del usuario)

`brand.category`, `brand.intent`, `brand.infoGain`, `brand.adjacent`,
`brand.differentiators`, `brand.competitors`, `brand.budgetTiers`,
`causal[]`, `dataTable`, `eeat[]`, `authorship`.

## Comportamiento (decidido con el usuario)

- **Rellenar solo campos vacíos.** Nunca pisa lo que el usuario ya escribió.
- Cada campo autocompletado se marca visualmente como **"sugerido — revísalo"**
  (clase CSS + etiqueta discreta). Al editar el campo (evento `input`/`change`),
  la marca de sugerido desaparece.
- Al terminar, **resumen** de resultados: "Rellené N campos desde `dominio`: …"
  + lo que NO encontró (p. ej. "La web no tiene schema FAQPage").

## Componentes

### 1. Frontend — nuevo campo y botón (paso 1 · Marca y empresa)

- Añadir campo **"Sitio web"** en el paso `step-brand` → `state.brand.website` (nuevo).
  Es la fuente única desde la que se crawlea.
- Botón **⚡ Autocompletar desde mi web** junto al campo:
  - Deshabilitado hasta que haya una URL válida.
  - Spinner mientras crawlea; reutiliza `auditEndpoint()` (`/api/audit`).
  - Al recibir respuesta, ejecuta `applyAutofill(data)`.

### 2. Frontend — `applyAutofill(data)`

- Recibe `data` (objeto crudo del backend).
- Para cada campo mapeado: si el campo en `state` está **vacío**, lo rellena, lo marca en
  `state.suggested[<path>] = true`, y refresca la UI de ese paso.
- FAQs: si `state.faqs` está vacío y `data.faqs.length`, los inserta.
- Guarda estado (`saveState()`), renderiza resumen.

### 3. Frontend — marca "sugerido"

- Estado nuevo `state.suggested = {}` (mapa de rutas de campo rellenadas por la máquina).
- CSS: borde/acento sutil + etiqueta "sugerido" en inputs marcados.
- Al editar un campo marcado, se borra su entrada de `state.suggested`.
- No persiste como dato de negocio; es solo ayuda visual (puede persistir en localStorage
  sin problema, pero se limpia al editar).

### 4. Backend — `functions/api/audit.js`

- Añadir a la respuesta un objeto **`data`** (además de `scores`/`findings`, que NO cambian):
  ```
  data: {
    website, domain,
    robotsText,               // texto crudo del robots.txt (ya se descarga)
    metaNoindex: 'yes'|'no',
    jsRendered: 'yes'|'no'|'unsure',
    brandName, description,
    h1,
    faqs: [ { question, answer }, ... ]   // vacío si no hay FAQPage
  }
  ```
- Extractores nuevos (pequeños, sobre el HTML/robots ya descargados):
  - `og:site_name` / `<title>` limpio.
  - `meta description` / `og:description`.
  - `<meta name="robots">` → noindex sí/no.
  - Q&A desde bloques JSON-LD `FAQPage` (reusar `extractJsonLd`).
  - Heurística JS-rendered (texto visible en HTML crudo vs shell casi vacío).
- Respuesta **retrocompatible**: clientes viejos ignoran `data`.

## Restricciones del proyecto (CLAUDE.md)

- Todo texto nuevo en **ES y EN** (objeto `T`).
- No romper autoguardado (`localStorage`), exports ni el flujo de construcción existente.
- Cambios solo en `1009.html` + `audit.js`. `index.html` público intacto.
- Probar de verdad con `npx wrangler pages dev .` (curl + navegador) antes de dar nada
  por bueno. Las Pages Functions no corren abriendo el HTML como archivo suelto.

## Riesgo / dependencia crítica

`window.AUDIT_API_BASE = 'https://radar.sarauter.com'`. Ese subdominio está (según notas del
proyecto) **tras Cloudflare Access**. Si `/api/audit` no es alcanzable desde el navegador
(CORS o muro de Access), **toda la feature es inútil**.

**Verificación obligatoria en el plan (antes de programar la UI):**
1. `curl -X POST https://radar.sarauter.com/api/audit -H 'Content-Type: application/json' -d '{"url":"sarauter.com"}'`
2. Probar el audit actual desde el navegador en la herramienta real.

Si está amurallado: exponer la función en una ruta pública (o mover el backend a la propia
Pages del proyecto sin Access delante). Este punto se resuelve **primero**.

## Criterios de éxito

- Con una URL en el paso 1, un clic rellena robots.txt, meta noindex, nombre, descripción,
  H1, resumen y FAQs (cuando existan) sin pisar lo ya escrito.
- Los campos rellenados se ven marcados como "sugerido" y la marca se va al editarlos.
- El diagnóstico (scores/findings) sigue funcionando igual que antes.
- Verificado con `wrangler` + una web real, no solo asumido.

## Fuera de alcance (YAGNI)

- Crawl de múltiples páginas del sitemap (solo la home por ahora).
- Auto-relleno de categoría, Information Gain, tablas, E-E-A-T, tripletas causales.
- Cualquier cambio en el `index.html` público.
