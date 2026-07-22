# RADAR — Auditor + Constructor GEO/AEO

Herramienta de una sola página + 3 funciones serverless (Cloudflare Pages).

- `index.html` — la herramienta (frontend).
- `functions/api/audit.js` — auditoría de URL (POST /api/audit).
- `functions/api/unlock.js` — login de equipo (POST /api/unlock).
- `functions/api/lead.js` — formulario de contacto (POST /api/lead).

**Antes de que funcione**, lee `DEPLOY.md`: hay que desplegar en Cloudflare Pages
y configurar las variables de entorno (`OPTIMIZER_PASSWORD`, y una vía de envío
de leads). Sin las funciones desplegadas, auditar/login/contacto no funcionan.
