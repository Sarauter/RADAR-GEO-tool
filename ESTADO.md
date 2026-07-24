# Estado del proyecto — RADAR (Auditor GEO/AEO)

Carpeta local: `RADAR Geo Tool NEW` (no es repo git local — se sube a GitHub por la web).
GitHub: `Sarauter/RADAR-GEO-tool` · Hosting: Cloudflare Pages (funciones) + GitHub Pages (mismo repo, para la URL pública).

## Qué es — ARQUITECTURA PARTIDA EN DOS (desde 2026-07-23)
El proyecto se separó en dos archivos independientes para eliminar la dependencia de
Cloudflare (KV login + Resend) y del dueño de la cuenta:

- **Parte 1 — pública (`index.html`):** landing + diagnóstico gratuito de una URL + botón
  "Corregir/Contactar" que abre un formulario de contacto **por mailto** a
  `marketing@sarauter.com`. El constructor NO es accesible desde aquí (`isUnlocked()` fijo a
  `false`, sin enlace de login). Único backend: `/api/audit`.
- **Parte 2 — privada (`1009.html`):** la herramienta/constructor, con
  **login client-side** dentro del archivo (usuario/clave en las constantes `RADAR_USER`/`RADAR_PASS` de `1009.html`). Sin backend,
  almacenamiento propio (`STORAGE_KEY='geo-arc-radar-tool-v1'`) para no cruzarse con la pública.

Verificado en local con wrangler + navegador (2026-07-23): diagnóstico renderiza y enlaza
contacto; mailto se construye y codifica bien; login rechaza clave mala, no se puede cerrar sin
entrar, clave correcta entra al constructor; generar prompts / export / autoguardado OK; sin
errores de consola en ninguno de los dos.

## Archivos clave
- `index.html` — parte pública. `window.AUDIT_API_BASE = 'https://radar.sarauter.com'` (fijo).
- `1009.html` — parte privada (herramienta con login). URL "escondida".
- `functions/api/audit.js` — auditoría de una URL. **Ya funciona en producción**, verificado.
- ~~`functions/api/lead.js`~~ — ELIMINADO (contacto ahora por mailto).
- ~~`functions/api/unlock.js`~~ — ELIMINADO (login ahora client-side en el archivo privado).
  (Si siguen en GitHub, son inofensivos; borrado opcional — ver `SUBIR-A-GITHUB.md`.)
- `SUBIR-A-GITHUB.md` — guía simple de subida (solo GitHub, sin Cloudflare).
- `DEPLOY.md` — backend legacy (KV/Resend). **Obsoleto tras el split**, mantenido solo de referencia.
- `README.md` — overview + nota de la URL pública.

## URL pública — YA RESUELTO, no hace falta tocar nada
`https://sarauter.com/RADAR-GEO-tool/` **ya funciona** (verificado, incluida la auditoría
cross-origin real). GitHub anida automáticamente los repos de proyecto bajo el dominio
personalizado de la web principal (que es un GitHub Pages user site). No se tocó DNS ni
el repo de la web principal de Sarauter. `radar.sarauter.com` sigue siendo accesible
directamente si alguien la escribe (no es un secreto, solo no se promociona).

## Hecho recientemente
- **AUTOCOMPLETAR DESDE LA WEB (2026-07-23)** — la mitad que faltaba del "puente
  auditoría→constructor". Hasta ahora el crawl solo servía para el diagnóstico y el botón
  "Resolver" te llevaba a una sección **vacía**; había que rellenarlo todo a mano (incluido
  copiar y pegar tu propio robots.txt). Ahora:
  - `functions/api/audit.js` devuelve un objeto **`data`** con lo crudo del sitio
    (`robotsText`, `metaNoindex`, `jsRendered`, `brandName`, `description`, `h1`, `faqs`,
    `domain`, `website`). `scores` y `findings` **no cambian** (retrocompatible).
  - `1009.html`: nuevo campo **"Sitio web"** en el paso Marca + botón
    **⚡ Autocompletar desde mi web** → rellena **solo los campos vacíos**, los marca en
    morado como "sugerido" (la marca se borra al editar y sobrevive a recargar), y muestra un
    resumen de qué rellenó y qué no encontró. Textos en ES y EN.
  - Reglas respetadas: nunca pisa lo que ya escribiste; las FAQs se **fusionan** con el
    andamiaje de 8 arquetipos (no lo reemplazan) y respetan preguntas editadas a mano;
    `jsRendered` nunca contesta "no" por su cuenta (solo `si`/`unsure`) para no capar el score
    de contenido a 40/100 basándose en una suposición.
  - Verificado de verdad (curl contra `wrangler pages dev` con un fixture de meta-tags difíciles
    + navegador real): apóstrofos y `&` se extraen bien, orden invertido de atributos en `<meta>`
    funciona, FAQs se decodifican, no hay XSS (todo el contenido crawleado va escapado) y el
    localStorage antiguo sigue cargando sin romperse.
  - Diseño y plan: `docs/superpowers/specs/2026-07-23-autocompletar-desde-web-design.md` y
    `docs/superpowers/plans/2026-07-23-autocompletar-desde-web.md`.
  - **Este cambio está solo en local — falta subir `1009.html` y `functions/api/audit.js`.**
- Eliminado el botón "Cargar ejemplo (sarauter.com)" del panel de auditoría (y la función
  `loadExampleAudit()` + su i18n): auditar el propio sarauter.com daba una puntuación mala
  (Contenido 47 / Distribución 15 / GEO 31), quedaba mal como demo. Verificado: el botón ya
  no aparece en ES/EN, sin errores de consola, el flujo manual de auditar sigue intacto.
  **Este cambio está solo en local — falta re-subir `index.html` a GitHub.**
  (Nota: esto NO afecta al botón "O carga un ejemplo real (kstudio.es)" de la landing, que
  precarga el constructor con un caso ficticio distinto — ese no se tocó.)

## Pendientes — ahora SOLO subir archivos a GitHub (sin Cloudflare, sin el marido)

El split eliminó la dependencia de Cloudflare/KV/Resend. Lo único que queda:

1. **Subir a GitHub** (Add file → Upload files) los TRES archivos con cambios locales
   pendientes: `index.html`, `1009.html` y **`functions/api/audit.js`**.
   Deploy automático. Guía: `SUBIR-A-GITHUB.md`.
   ⚠️ **Orden importante:** sube `functions/api/audit.js` **antes o a la vez** que `1009.html`.
   Si subes solo `1009.html`, el botón de autocompletar llamará a un backend que todavía no
   devuelve `data` y dirá "no pude rellenar nada".
2. **Probar en producción** las dos URLs (lo hace Andrea):
   - Pública: auditar una URL + botón Corregir/Contactar abre el mailto a `marketing@sarauter.com`.
   - Privada: `…/1009.html` → login usuario/clave en las constantes `RADAR_USER`/`RADAR_PASS` de `1009.html` → constructor →
     paso "Marca y empresa" → poner una URL en "Sitio web" → **⚡ Autocompletar desde mi web**
     y comprobar que rellena (robots.txt, dominio, nombre, descripción, H1, FAQs si las hay).
3. *(Opcional)* Borrar en GitHub `functions/api/unlock.js` y `functions/api/lead.js` (ya no se usan).
   `functions/api/audit.js` NO se toca.

## Decisiones ya tomadas (no volver a preguntar)
- Nombre de la herramienta: **RADAR** (antes "Mentionate" en el proyecto viejo — este es el
  proyecto nuevo, construido con Claude web/no-code).
- **Arquitectura partida en dos** (2026-07-23): pública (`index.html`, diagnóstico + contacto
  mailto) y privada (`1009.html`, herramienta con login client-side). Motivo:
  quitar de encima Cloudflare KV + Resend y la dependencia del dueño de la cuenta. Es un MVP;
  el login client-side es una barrera de obscuridad, no seguridad fuerte (sin datos de clientes).
- URL pública: `sarauter.com/RADAR-GEO-tool/`. La privada cuelga de la misma ruta con el nombre
  de archivo "escondido". `radar.sarauter.com` sigue sirviendo la función `audit.js`.
- **Login:** client-side dentro del archivo privado (usuario/clave en las constantes `RADAR_USER`/`RADAR_PASS` de `1009.html`). Cambiar
  la clave = editar `RADAR_PASS` y re-subir. (Sustituye al plan anterior de KV multiusuario.)
- **Email de contacto de destino: `marketing@sarauter.com`** vía mailto (decisión de Andrea el
  2026-07-23, cambiando el `sarauter@gmail.com` que se había fijado antes). Se cambia en la
  constante `LEAD_TO` de `index.html`.
- **Autocompletar = solo campos vacíos, nunca sobrescribe** (2026-07-23). Lo crawleado es una
  *sugerencia* que el usuario revisa, no una verdad. Por eso se marca en morado y hay un resumen.
  El autocompletado se limita a lo técnico + contenido básico; categoría, Information Gain,
  competidores, tripletas causales y tablas siguen siendo 100% del usuario (demasiado inciertos
  para adivinarlos).
- **La "versión automática antigua" NO existe** — se buscó en 3 repos (`constructor-auditor-non-binary`,
  `GEO-AEO-Audit-Tool`, `constructor-auditor-GEO-AEO`) y 3 archivos sueltos. Solo se había
  construido la mitad del crawl (diagnóstico); el "precargar la sección" del prompt original se
  implementó como *navegar* a la sección vacía. No volver a buscarla: se construyó aquí.
