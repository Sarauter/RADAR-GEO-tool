# RADAR — Auditor GEO/AEO

**Descubre por qué ChatGPT, Perplexity o Google AI recomiendan a tu competencia y no a ti.**

RADAR analiza una web y puntúa lo preparada que está para que los motores de IA la lean, la
entiendan y la citen. Devuelve un diagnóstico con carencias priorizadas, cada una explicada en
lenguaje llano.

🔗 **Pruébalo:** [sarauter.com/RADAR-GEO-tool](https://sarauter.com/RADAR-GEO-tool/)

---

## El problema

El SEO clásico optimiza para que un humano haga clic en un enlace azul. Pero cada vez más gente
pregunta directamente a una IA y **se queda con la respuesta**, sin visitar ninguna web. Si el
modelo no puede leerte, no te entiende o no encuentra en ti un dato que merezca citarse, cita a
otro. Y tú no te enteras: no aparece en Analytics, porque nunca hubo visita.

GEO (*Generative Engine Optimization*) y AEO (*Answer Engine Optimization*) son las disciplinas
que atacan eso. RADAR mide dónde estás.

## Qué comprueba

Con una URL, y en unos segundos:

| Área | Qué mira |
|---|---|
| **Acceso de bots IA** | Si `robots.txt` bloquea GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot… |
| **Legibilidad** | Si el contenido existe en el HTML sin ejecutar JavaScript, y si hay `noindex` |
| **Datos estructurados** | JSON-LD: `Organization`, `Article`, `FAQPage` |
| **Autoridad (E-E-A-T)** | Autor, fecha de actualización, perfiles `sameAs` |
| **Estructura de respuesta** | Resúmenes extraíbles, encabezados en forma de pregunta |
| **Evidencia** | Presencia de datos medibles (%, cifras, plazos) frente a adjetivos vacíos |
| **Distribución** | `/llms.txt`, sitemap |

Salida: tres puntuaciones (Contenido · Distribución · GEO Readiness) y una lista de carencias
ordenadas por severidad.

## Cómo está hecho

Sin framework, sin build, sin dependencias en el navegador. HTML + CSS + JS vanilla y una función
serverless.

```
index.html                 Parte pública: diagnóstico por URL + contacto
functions/api/audit.js     Cloudflare Pages Function — el crawler y el motor de scoring
```

**Por qué el backend existe.** Un navegador no puede leer el `robots.txt` ni el HTML de otro
dominio: lo impide CORS. La auditoría corre por tanto en el servidor (Cloudflare Pages Function),
que descarga HTML, `robots.txt`, `/llms.txt` y sitemap en paralelo, con timeout, límite de tamaño
y un User-Agent identificable.

**Autocompletado desde la web.** El constructor no se rellena a mano: la misma función que audita
devuelve además los datos crudos del sitio (`robots.txt`, meta description, `<h1>`, FAQs del schema
`FAQPage`…) y el frontend los baja a los campos vacíos, marcándolos como sugerencias revisables.
Nunca sobrescribe lo que hayas escrito tú.

Bilingüe ES/EN, autoguardado en `localStorage`, y exportación a Markdown, CSV, JSON y schema
`FAQPage` en JSON-LD.

## Desarrollo local

Las Pages Functions **no** funcionan abriendo el HTML como archivo suelto. Hace falta wrangler:

```bash
npx wrangler pages dev . --port 8788
```

Y luego `http://localhost:8788`. Para probar solo el backend:

```bash
curl -s -X POST http://localhost:8788/api/audit \
  -H "Content-Type: application/json" \
  -d '{"url":"example.com"}'
```

## Estado y limitaciones

Es un MVP honesto, y conviene decir qué no es:

- **Los umbrales de puntuación son heurísticos.** Están basados en las señales que los motores
  generativos usan hoy, pero no son un estándar de la industria. Documentar y citar el criterio
  de cada uno es el siguiente paso del proyecto.
- **Analiza la home, no el sitio entero.** El recorrido del sitemap está fuera de alcance por ahora.
- **El detector de "contenido sin JavaScript" es una estimación** por volumen de texto en el HTML
  crudo. Ante la duda responde "no estoy seguro" en vez de arriesgar un falso negativo, porque un
  falso "no" penalizaría injustamente toda la puntuación.
- **El constructor no guarda nada en ningún servidor.** Todo vive en el `localStorage` de tu
  navegador. Su acceso es una barrera de obscuridad, no un sistema de autenticación.

## Créditos

Protocolo CITAR (Gestazión) + framework de evidencia y narrativa (Jolly Search), fusionados y
adaptados por [Sarauter](https://sarauter.com).
