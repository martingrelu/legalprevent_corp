// Plantilla del blog (Fase 1 del motor SEO): el blog es solo en español y no puede
// publicar nada sin aprobación. Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadArticles, parseSource, renderAll, renderArticle, renderIndex } from "../seo-engine/blog-render.mjs";

const fixtures = new URL("./fixtures/blog/", import.meta.url).pathname;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const [approved] = loadArticles(fixtures);
const draft = (status) => ({ ...approved, meta: { ...approved.meta, review_status: status } });

test("la plantilla es solo español: sin hreflang, selector ni language.js", () => {
  for (const html of [renderArticle(approved), renderIndex([approved])]) {
    assert.match(html, /<html lang="es">/);
    assert.doesNotMatch(html, /hreflang/);
    assert.doesNotMatch(html, /language-switch|language\.js/);
    assert.doesNotMatch(html, /\/en\//);
    assert.match(html, /og:locale" content="es_ES"/);
  }
});

test("canonical propio, og:url y breadcrumbs coherentes", () => {
  const html = renderArticle(approved);
  const url = "https://legalprevent.com/blog/articulo-de-prueba/";
  assert.deepEqual([...html.matchAll(/rel="canonical" href="([^"]+)"/g)].map((m) => m[1]), [url]);
  assert.match(html, new RegExp(`og:url" content="${url}"`));
  const index = renderIndex([approved]);
  assert.match(index, /rel="canonical" href="https:\/\/legalprevent\.com\/blog\/"/);
});

test("el artículo muestra autoría, fechas y responsable de revisión", () => {
  const html = renderArticle(approved);
  assert.match(html, /Equipo Jurídico de LegalPrevent/);
  assert.match(html, /<time datetime="2026-10-01">01\/10\/2026<\/time>/);
  assert.match(html, /<time datetime="2026-10-15">15\/10\/2026<\/time>/);
  assert.match(html, /Luis Martín Grecco, abogado/);
  assert.match(html, /"reviewedBy"/);
});

test("un artículo sin aprobar no declara revisor y lleva noindex", () => {
  for (const status of ["draft", "in_review"]) {
    const html = renderArticle(draft(status));
    assert.doesNotMatch(html, /reviewedBy/);
    assert.doesNotMatch(html, /Luis Martín Grecco/);
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.match(html, /Pendiente de aprobación/);
  }
});

test("el índice solo lista artículos aprobados", () => {
  const index = renderIndex([approved, draft("in_review")].map((a, i) => (i ? { ...a, meta: { ...a.meta, slug: "otro", title: "Borrador secreto", review_status: "in_review" } } : a)));
  assert.match(index, /articulo-de-prueba\//);
  assert.doesNotMatch(index, /Borrador secreto/);
  assert.match(renderIndex([]), /Próximamente/);
});

test("la validación rechaza aprobaciones y datos inválidos", () => {
  const source = (patch) => `---\n${JSON.stringify({ ...approved.meta, ...patch })}\n---\ncuerpo`;
  assert.throws(() => parseSource(source({ approved_by: "Otra persona" })), /approved_by/);
  assert.throws(() => parseSource(source({ approved_at: undefined })), /approved_at/);
  assert.throws(() => parseSource(source({ slug: "Mal Slug" })), /slug/);
  assert.throws(() => parseSource(source({ date_modified: "2026-09-01" })), /date_modified/);
  assert.throws(() => parseSource(source({ review_status: "publicado" })), /review_status/);
  assert.throws(() => parseSource(source({ sources: [{ title: "x", url: "http://x.es", status: "vigente", consulted_at: "2026-10-01" }] })), /https/);
  assert.throws(() => parseSource("sin front matter"), /bloque JSON/);
});

test("las fuentes muestran su estado normativo y el contenido se escapa", () => {
  const html = renderArticle(approved);
  assert.match(html, /Vigente\. Consultada el 14\/10\/2026/);
  assert.match(html, /Proyecto \(no vigente\)/);
  assert.match(html, /&lt;etiquetas&gt; &amp; símbolos/);
  assert.doesNotMatch(html, /<etiquetas>/);
});

test("el JSON-LD es válido y contiene Article, WebPage y BreadcrumbList", () => {
  const html = renderArticle(approved);
  const json = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(json["@graph"].map((n) => n["@type"]), ["Article", "WebPage", "BreadcrumbList"]);
  assert.equal(json["@graph"][0].author.name, "Equipo Jurídico de LegalPrevent");
});

test("la salida es determinista", () => {
  assert.deepEqual([...renderAll([approved])], [...renderAll([approved])]);
});

test("no toca producción: la plantilla no está en la allowlist ni en el sitemap", () => {
  const allowlist = read(".github/pages-allowlist.txt");
  assert.doesNotMatch(allowlist, /blog|seo-engine|content\//);
  assert.doesNotMatch(read("sitemap.xml"), /\/blog\//);
});

test("el build inglés no incluye páginas del blog", () => {
  assert.doesNotMatch(read("tools/build-i18n.mjs"), /blog/);
});
