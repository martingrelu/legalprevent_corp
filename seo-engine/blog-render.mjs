// Plantilla del blog (Fase 1 del motor SEO). Sin dependencias.
// Fuente: content/blog/<slug>.md  →  Salida: blog/<slug>/index.html y blog/index.html
//
// Formato de la fuente: un bloque JSON entre dos líneas `---` y, debajo, el cuerpo
// en un subconjunto de Markdown (##, ###, párrafos, listas con "- ", **negrita**,
// *cursiva* y [texto](https://… o /ruta)). Todo el texto se escapa.
//
// Uso:  node seo-engine/blog-render.mjs          escribe blog/
//       node seo-engine/blog-render.mjs --check  falla si blog/ no coincide con la fuente
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "https://legalprevent.com";
export const AUTHOR = "Equipo Jurídico de LegalPrevent";
export const REVIEWER = { name: "Luis Martín Grecco", title: "Abogado" };
const STATUSES = ["draft", "in_review", "approved"];
const SOURCE_STATUSES = { vigente: "Vigente", proyecto: "Proyecto (no vigente)", derogada: "Derogada" };

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const longDate = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

export function parseSource(text, file = "(fuente)") {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: falta el bloque JSON entre '---'`);
  let meta;
  try {
    meta = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${file}: el bloque inicial no es JSON válido (${error.message})`);
  }
  return { meta: validate(meta, file), body: match[2].trim() };
}

export function validate(meta, file = "(fuente)") {
  const fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.slug ?? "")) fail("slug inválido (minúsculas, números y guiones)");
  for (const key of ["title", "description"]) {
    if (typeof meta[key] !== "string" || !meta[key].trim()) fail(`falta ${key}`);
  }
  for (const key of ["date_published", "date_modified"]) {
    if (!isoDate.test(meta[key] ?? "")) fail(`${key} debe ser AAAA-MM-DD`);
  }
  if (meta.date_modified < meta.date_published) fail("date_modified anterior a date_published");
  if (!STATUSES.includes(meta.review_status)) fail(`review_status debe ser uno de ${STATUSES.join(", ")}`);
  if (meta.review_status === "approved") {
    if (!isoDate.test(meta.approved_at ?? "")) fail("un artículo aprobado necesita approved_at (AAAA-MM-DD)");
    if (meta.approved_by !== REVIEWER.name) fail(`approved_by debe ser "${REVIEWER.name}"`);
  }
  for (const source of meta.sources ?? []) {
    if (!source.title || !/^https:\/\//.test(source.url ?? "")) fail("cada fuente necesita title y url https");
    if (!(source.status in SOURCE_STATUSES)) fail(`estado de fuente inválido: ${source.status}`);
    if (!isoDate.test(source.consulted_at ?? "")) fail("cada fuente necesita consulted_at (AAAA-MM-DD)");
  }
  return meta;
}

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+|\/[^)\s]*)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function renderBody(markdown) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith("### ")) return `<h3>${inline(block.slice(4))}</h3>`;
      if (block.startsWith("## ")) return `<h2>${inline(block.slice(3))}</h2>`;
      if (block.split("\n").every((line) => line.startsWith("- "))) {
        return `<ul class="legal-list">\n${block.split("\n").map((l) => `          <li>${inline(l.slice(2))}</li>`).join("\n")}\n        </ul>`;
      }
      return `<p>${inline(block.replace(/\n/g, " "))}</p>`;
    })
    .join("\n        ");
}

const header = (up) => `    <header class="site-header">
      <a class="brand" href="${up}#inicio" aria-label="LEGAL PREVENT inicio">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
        <span>LEGAL PREVENT</span>
      </a>
      <nav class="site-nav legal-nav" aria-label="Navegación legal">
        <a href="${up}#soluciones">Soluciones</a>
        <a href="${up}#precios">Precios</a>
        <a href="${up}#contacto">Contacto</a>
      </nav>
      <a class="header-cta" href="${up}#contacto">Solicitar demo</a>
    </header>`;

const footer = (up) => `    <footer class="site-footer">
      <a class="brand" href="${up}#inicio" aria-label="LEGAL PREVENT inicio">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
        <span>LEGAL PREVENT</span>
      </a>
      <nav aria-label="Enlaces de pie de página">
        <a href="${up}#areas">Áreas</a>
        <a href="${up}#sectores">Sectores</a>
        <a href="${up}#precios">Precios</a>
        <a href="${up}#contacto">Contacto</a>
        <a href="${up}aviso-legal/">Aviso Legal</a>
        <a href="${up}politica-privacidad/">Política de Privacidad</a>
        <a href="${up}politica-cookies/">Política de Cookies</a>
        <a href="${up}terminos-condiciones/">Términos y Condiciones</a>
        <a href="${up}documentacion-legal/">Documentación legal</a>
      </nav>
      <p class="copyright">© <span data-year></span> LEGAL PREVENT. Todos los derechos reservados.</p>
    </footer>`;

// Sin hreflang, sin selector de idioma y sin language.js: el blog solo existe en español.
function page({ up, title, description, path, robots, jsonld, main }) {
  const url = BASE + path;
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)}</title>
    <meta name="description" content="${escape(description)}" />${robots ? `\n    <meta name="robots" content="${robots}" />` : ""}
    <meta property="og:title" content="${escape(title)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:type" content="${path === "/blog/" ? "website" : "article"}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:site_name" content="LegalPrevent" />
    <meta property="og:locale" content="es_ES" />
    <meta property="og:image" content="${BASE}/assets/og/og-es-v1.jpg" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="LegalPrevent: prevención legal y cumplimiento normativo para empresas" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="${up}styles.css" />
    <script type="application/ld+json">${JSON.stringify(jsonld, null, 2)}</script>
  </head>
  <body>
${header(up)}

${main}

${footer(up)}
    <script src="${up}script.js"></script>
  </body>
</html>
`;
}

export function renderArticle({ meta, body }) {
  const approved = meta.review_status === "approved";
  const path = `/blog/${meta.slug}/`;
  const url = BASE + path;
  const sources = (meta.sources ?? [])
    .map(
      (s) =>
        `          <li><a href="${escape(s.url)}" rel="noopener">${escape(s.title)}</a> — ${SOURCE_STATUSES[s.status]}. Consultada el ${longDate(s.consulted_at)}.</li>`
    )
    .join("\n");
  const graph = [
    {
      "@type": "Article",
      "@id": `${url}#article`,
      headline: meta.title,
      description: meta.description,
      inLanguage: "es",
      datePublished: meta.date_published,
      dateModified: meta.date_modified,
      mainEntityOfPage: { "@id": url },
      author: { "@type": "Organization", name: AUTHOR, url: BASE + "/" },
      publisher: { "@id": `${BASE}/#organization` },
    },
    {
      "@type": "WebPage",
      "@id": url,
      url,
      name: meta.title,
      inLanguage: "es",
      mainEntity: { "@id": `${url}#article` },
      ...(approved && {
        lastReviewed: meta.approved_at,
        reviewedBy: { "@type": "Person", name: REVIEWER.name, jobTitle: REVIEWER.title },
      }),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Inicio", item: BASE + "/" },
        { "@type": "ListItem", position: 2, name: "Blog", item: BASE + "/blog/" },
        { "@type": "ListItem", position: 3, name: meta.title, item: url },
      ],
    },
  ];
  const main = `    <main class="legal-page section-shell">
      <nav class="breadcrumb" aria-label="Migas de pan">
        <a href="../../">Inicio</a><span>/</span><a href="../">Blog</a><span>/</span><span>${escape(meta.title)}</span>
      </nav>
      <header class="legal-hero">
        <span class="section-label">Blog</span>
        <h1>${escape(meta.title)}</h1>
        <p>${escape(meta.description)}</p>
      </header>

      <section class="legal-card">
        <dl class="legal-data">
          <div><dt>Autoría</dt><dd>${AUTHOR}</dd></div>
          <div><dt>Publicado</dt><dd><time datetime="${meta.date_published}">${longDate(meta.date_published)}</time></dd></div>
          <div><dt>Última actualización</dt><dd><time datetime="${meta.date_modified}">${longDate(meta.date_modified)}</time></dd></div>${
            approved
              ? `\n          <div><dt>Revisión jurídica</dt><dd>${REVIEWER.name}, ${REVIEWER.title.toLowerCase()} (<time datetime="${meta.approved_at}">${longDate(meta.approved_at)}</time>)</dd></div>`
              : `\n          <div><dt>Revisión jurídica</dt><dd>Pendiente de aprobación. No publicar.</dd></div>`
          }
        </dl>
      </section>

      <article class="legal-card">
        ${renderBody(body)}
      </article>${
        sources
          ? `\n\n      <section class="legal-card">\n        <h2>Fuentes oficiales</h2>\n        <ul class="legal-list">\n${sources}\n        </ul>\n      </section>`
          : ""
      }

      <section class="legal-card">
        <p>Este contenido tiene carácter informativo y no constituye asesoramiento jurídico personalizado.</p>
      </section>
    </main>`;
  return page({
    up: "../../",
    title: `${meta.title} | LEGAL PREVENT`,
    description: meta.description,
    path,
    robots: approved ? "" : "noindex",
    jsonld: { "@context": "https://schema.org", "@graph": graph },
    main,
  });
}

export function renderIndex(articles) {
  const published = articles
    .filter(({ meta }) => meta.review_status === "approved")
    .sort((a, b) => b.meta.date_published.localeCompare(a.meta.date_published));
  const items = published.length
    ? published
        .map(
          ({ meta }) => `      <section class="legal-card">
        <h2><a href="${meta.slug}/">${escape(meta.title)}</a></h2>
        <p>${escape(meta.description)}</p>
        <p><time datetime="${meta.date_modified}">Actualizado el ${longDate(meta.date_modified)}</time></p>
      </section>`
        )
        .join("\n\n")
    : `      <section class="legal-card">\n        <p>Próximamente publicaremos artículos de prevención legal y cumplimiento normativo.</p>\n      </section>`;
  const title = "Blog de prevención legal y cumplimiento normativo | LEGAL PREVENT";
  const description = "Artículos del Equipo Jurídico de LegalPrevent sobre prevención legal y cumplimiento normativo para empresas.";
  const main = `    <main class="legal-page section-shell">
      <nav class="breadcrumb" aria-label="Migas de pan">
        <a href="../">Inicio</a><span>/</span><span>Blog</span>
      </nav>
      <header class="legal-hero">
        <span class="section-label">Blog</span>
        <h1>Blog de prevención legal</h1>
        <p>${escape(description)}</p>
      </header>

${items}
    </main>`;
  return page({
    up: "../",
    title,
    description,
    path: "/blog/",
    robots: "",
    jsonld: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": `${BASE}/blog/`,
          url: `${BASE}/blog/`,
          name: title,
          inLanguage: "es",
          isPartOf: { "@id": `${BASE}/#website` },
        },
      ],
    },
    main,
  });
}

export function renderAll(articles) {
  const files = new Map([["blog/index.html", renderIndex(articles)]]);
  for (const article of articles) files.set(`blog/${article.meta.slug}/index.html`, renderArticle(article));
  return files;
}

export function loadArticles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseSource(readFileSync(resolve(dir, name), "utf8"), name));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = renderAll(loadArticles(resolve(root, "content/blog")));
  const check = process.argv.includes("--check");
  let drift = 0;
  for (const [path, html] of files) {
    const target = resolve(root, path);
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== html) {
        console.error(`Desfase: ${path}`);
        drift++;
      }
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
      console.log(`Escrito: ${path}`);
    }
  }
  if (drift) process.exit(1);
}
