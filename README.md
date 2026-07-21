# RADAR-GEO-tool
RADAR: Constructor + Auditor GEO / SEO / AEO

# Constructor + Auditor GEO / SEO / AEO

**Una sola página HTML que audita en vivo si tu contenido está listo para ser citado por motores de IA — y te dice exactamente qué corregir.**

No es una plantilla de campos vacíos. Es un auditor determinista: cada campo se evalúa contra reglas concretas de SEO, GEO (Generative Engine Optimization) y AEO (Answer Engine Optimization) mientras escribes, con semáforo 🔴🟡🟢, puntuación 1–10 y una sugerencia reescribible en lugar de un consejo genérico.

Corre 100% en el navegador. Sin backend, sin API keys, sin envío de datos. Un solo archivo.

---

## Por qué existe

La mayoría de guías de "optimización para IA" son checklists estáticas: te dicen *qué* hacer, no *si lo hiciste bien*. Esta herramienta invierte eso. Pega tu contenido y te dice, campo por campo, por qué un LLM te citaría o citaría a otro en tu lugar.

Fusiona dos frameworks en un mismo flujo, compartiendo un único bloque de datos de Empresa para no duplicar inputs:

| Módulo | Qué produce | Framework base |
|---|---|---|
| **1 · Constructor de Contenido** | El activo publicable (H1, resumen atómico, cuerpo causal, tablas, E-E-A-T, FAQs con Schema) | Protocolo **CITAR** |
| **2 · Motor de Prompts & Evidencia** | El plan de distribución (ICPs, narrativas, prompts priorizados, evidencia por canal) | Framework tipo Jolly Search |

Al final, un **GEO Readiness Score** combinado: no sirve de nada un contenido perfecto que ningún motor puede leer, ni un sitio perfectamente rastreable sin nada citable dentro.

---

## El Protocolo CITAR

El módulo de contenido sigue 8 pasos, cada uno con scoring heurístico en tiempo real:

1. **Acceso de crawlers IA** — Analiza el `robots.txt` que pegas, detecta 10 bots de IA conocidos (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider…) y verifica bloqueos, renderizado JS y `noindex`. Si un bot clave está bloqueado, el Score de Contenido queda topado en 40/100 con banner rojo permanente — porque nada de lo demás importa si no pueden leerte.
2. **Páginas** — N páginas, cada una con H1 + resumen atómico (≤50 palabras, sujeto-verbo-predicado, con dato medible) y vínculo a tripletas causales. Una página sin tripleta vinculada se queda en 🟡 aunque el resumen sea perfecto.
3. **Cuerpo causal** — Tripletas Característica → Mecanismo → Resultado con IDs estables. El vínculo es bidireccional: cada tripleta muestra en qué páginas se usa.
4. **Tablas comparativas** — Mínimo 3 filas, columnas personalizables. Penaliza tablas que no comparan nada real.
5. **E-E-A-T + Autoría** — Citas externas (Fuente / Año / URL verificable) + tarjeta de autoría (nombre, credenciales, perfil, última actualización). Ambas partes pesan en el score.
6. **FAQs** — Los 8 tipos del ciclo de decisión (definición → comparación → coste → implementación → requisitos → beneficio → tiempo → diferencial), ≤60 palabras, respuesta directa sin relleno. Incluye generador de **Schema FAQPage JSON-LD**.
7. **Checklist auto-computado** — No se marca a mano: se deriva del estado real de cada paso. Botón para copiar/descargar el contenido consolidado en `.md`, listo para pegar en el CMS.
8. **VARC Score** — Visibilidad · Autoridad · Reputación · Conversión.

> El protocolo se llama **CITAR** (no ARC) para evitar la confusión con acrónimos de ventas, y porque el objetivo literal es que la IA *te cite*.

---

## Módulo 2 — Prompts & Evidencia

- **Audiencia:** ICPs y personas con importancia 1–5, caso de uso y trigger.
- **Narrativas** con prueba de soporte (marca en 🟡 las que no tienen evidencia concreta).
- **Prompts por cluster:** Categoría · Alternativas · Comparación · Experiencia · Presupuesto · Caso de uso · Por rol.
- **Scoring de prioridad:** `Impacto × Probabilidad (del cluster) × Importancia de persona` → 🔴 <30 · 🟡 30–70 · 🟢 >70.
- **Evidencia por canal:** Reddit, G2/Capterra, YouTube, Quora, comunidad propia, prensa. Cubrir el número requerido en un solo canal se queda en 🟡 — la diversidad real es lo que da 🟢.
- **Superficie GEO / AEO / Ambas** por prompt.
- **Log de Validación:** registra chequeos cada 15 días (motor, prompt, ¿apareció la marca?, ¿narrativa correcta?, ¿fuente citada?, ¿quién más apareció?). El sistema avisa cuando pasan más de 15 días desde el último.

---

## Características técnicas

- **Un solo archivo HTML.** Vanilla JS, sin frameworks ni dependencias salvo Google Fonts.
- **Offline y privado.** Todo el scoring es heurístico y determinista en el navegador — cero llamadas a APIs externas. Tu contenido nunca sale de tu equipo.
- **Autoguardado** en `localStorage`.
- **Bilingüe ES/EN** con toggle, y lenguaje neutro en toda la interfaz.
- **Exportación:** proyecto completo (JSON), tabla de prompts (CSV), contenido consolidado (Markdown) y Schema FAQPage (JSON-LD).
- **Migración automática** desde el formato anterior (`zonaCero` único → `pages[]`) sin pérdida de datos.
- **IDs estables:** borrar una tripleta la desvincula automáticamente de todas las páginas que la usaban.

---

## Uso

Es una página estática. Tres formas de abrirla:

**Local** — Descarga `constructor-auditor-geo-seo-aeo.html` y ábrelo en cualquier navegador. No necesita servidor.

**GitHub Pages** (recomendado para tener una URL citable):

1. En el repo: **Settings → Pages → Source: `main` / root**.
2. Renombra el archivo a `index.html` (o enlázalo directo).
3. Quedará publicado en `https://sarauter.github.io/<nombre-del-repo>/`.

**Como herramienta de consultoría** — Cada proyecto de cliente se guarda/carga con el botón de JSON, así reutilizas la misma herramienta para varias marcas sin mezclar datos.

---

## Estado y roadmap

La página está terminada y es la fuente de verdad. Fusiona y reemplaza a dos proyectos anteriores:

- [`Sarauter/Plantilla-GEO`](https://github.com/Sarauter/Plantilla-GEO) — Protocolo de contenido (legacy).
- [`Sarauter/GEO-prompt-engine`](https://github.com/Sarauter/GEO-prompt-engine) — Motor de prompts (legacy).

Ambos quedan como componentes históricos. La versión unificada vive aquí.

**Próximos pasos abiertos:** mejora del scoring por filas vacías, refuerzo de accesibilidad (etiquetas asociadas, estado no dependiente solo de color), y reemplazo del sitio original en la migración de páginas.

---

## Autoría

Creado por **Andrea Saravia Sauter** — estratega de marketing B2B con más de 20 años en telecomunicaciones e infraestructura digital (LATAM y Europa), especializada en SEO, GEO y AEO.

- GitHub: [github.com/Sarauter](https://github.com/Sarauter)
- LinkedIn: [linkedin.com/in/andreasaraviasauter](https://linkedin.com/in/andreasaraviasauter)

Parte del portfolio de herramientas **SARAUTER**.

---

## Licencia

Sin licencia declarada por defecto. Si quieres permitir uso y reutilización, añade un archivo `LICENSE` (MIT es la opción habitual para herramientas de este tipo). Sin él, GitHub lo trata como "todos los derechos reservados".
