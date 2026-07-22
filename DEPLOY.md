# RADAR — Backend (Cloudflare Pages Functions)

Estas son las 3 funciones de servidor que hacen que la herramienta funcione. El HTML es solo el frontend; sin estas funciones, **auditar, login y contacto no funcionan** (que es justo lo que estabas viendo).

## Estructura de archivos en el repo

```
tu-repo/
├── index.html                 ← la herramienta (RADAR) — renombra RADAR.html a index.html
└── functions/
    └── api/
        ├── audit.js           ← POST /api/audit   (auditoría de URL)
        ├── unlock.js          ← POST /api/unlock  (login de equipo)
        └── lead.js            ← POST /api/lead    (formulario de contacto)
```

Cloudflare Pages detecta `/functions` automáticamente: cada archivo se publica en su ruta. Sin build command, sin framework. Solo haz push.

> Recuerda: abrir el HTML con doble clic (`file://`) o servirlo sin las funciones hace que las tres fallen. Solo funcionan desplegado en Cloudflare Pages o en local con `wrangler pages dev`.

---

## Variables de entorno

Se configuran en **Cloudflare → Pages → tu proyecto → Settings → Environment variables**. **Ninguna se sube al repo.**

| Función | Variable | ¿Obligatoria? | Para qué |
|---|---|---|---|
| audit | `AUDIT_USER_AGENT` | No | Sobrescribe el User-Agent de las peticiones salientes. |
| unlock | `OPTIMIZER_PASSWORD` | **Sí** (para que el login funcione) | La contraseña de equipo. |
| unlock | `OPTIMIZER_USER` | No | Si la pones, el usuario también debe coincidir. |
| lead | `LEAD_WEBHOOK_URL` | Una de las dos vías | Reenvía el lead como JSON a un webhook (Zapier / Make / Formspree / n8n). **La vía más fácil.** |
| lead | `RESEND_API_KEY` + `LEAD_TO` (+ `LEAD_FROM`) | Una de las dos vías | Envía el lead por email vía [Resend](https://resend.com). `LEAD_FROM` debe ser un remitente verificado. |

Si **no** configuras ninguna vía de `lead`, el contacto responde `not_configured` y el formulario muestra un error genérico. Configura `OPTIMIZER_PASSWORD` y una vía de lead y las dos empiezan a funcionar.

---

## Contratos JSON (por si tocas el frontend)

**POST `/api/audit`** — body `{ "url": "ejemplo.com" }`
```jsonc
{ "ok": true, "url": "...",
  "scores": { "content": 0, "distribution": 0, "geo": 0 },
  "findings": [
    { "severity": "critical|high|medium|low",
      "section": "crawlers|zerozone|causal|tables|eeat|faqs",
      "title":  { "es": "...", "en": "..." },
      "detail": { "es": "...", "en": "..." } }
  ] }
// error: { "ok": false, "error": "invalid_url" | "fetch_failed" }
```

**POST `/api/unlock`** — body `{ "user": "...", "password": "..." }`
```jsonc
{ "ok": true }                              // desbloqueado
{ "ok": false, "error": "not_configured" }  // falta OPTIMIZER_PASSWORD
{ "ok": false, "error": "bad" }             // usuario/contraseña incorrectos
```

**POST `/api/lead`** — body `{ firstName, lastName, email, company, message, consent, intent, url, score, lang }`
```jsonc
{ "ok": true }
{ "ok": false, "error": "invalid" | "not_configured" | "send_failed" }
```

---

## Qué analiza la auditoría

robots.txt (bloqueo de GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider, Amazonbot, Applebot-Extended, Meta-ExternalAgent…), `/llms.txt`, sitemap, JSON-LD (`Organization`, `Article`, `FAQPage`), autor y fecha de actualización, estructura de respuesta (H1 + resumen corto), datos medibles y bloque FAQ. Cada carencia enlaza al paso del constructor que la arregla.

Robustez incluida en las 3 funciones: timeout 8 s, User-Agent identificable, control de tamaño (2 MB), CORS y `OPTIONS`. La auditoría nunca deja la UI colgada: ante timeout, 403 o web caída devuelve `fetch_failed` con mensaje claro.

---

## Probar en local

```bash
npx wrangler pages dev .            # levanta el sitio + las 3 funciones en :8788
# (para probar login/lead en local, pásale las variables)
npx wrangler pages dev . --binding OPTIMIZER_PASSWORD=tuclave
```

```bash
curl -X POST http://localhost:8788/api/audit  -H "Content-Type: application/json" -d '{"url":"sarauter.com"}' | jq
curl -X POST http://localhost:8788/api/unlock -H "Content-Type: application/json" -d '{"password":"tuclave"}' | jq
```

Luego abre `http://localhost:8788`, prueba la auditoría, el login y el formulario.

---

## Nota sobre el score de Distribución

Desde una sola URL no se mide la distribución off-site real (Reddit, G2, YouTube…). El score de Distribución es un **proxy limitado** (perfiles `sameAs` + llms.txt). La distribución de verdad se trabaja en el módulo de Prompts & Evidencia del constructor.
