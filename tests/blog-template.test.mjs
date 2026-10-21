// Plantilla del blog (Fase 1 del motor SEO): el blog es solo en español, no publica nada sin
// aprobación verificable y nunca incluye el artículo ficticio de pruebas.
// Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEWER,
  checkOutput,
  contentHash,
  isCalendarDate,
  linkProblem,
  loadArticles,
  parseRaw,
  parseSource,
  renderAll,
  renderArticle,
  renderIndex,
} from "../seo-engine/blog-render.mjs";
import { verifyApprovalRecord } from "../seo-engine/verify-approval.mjs";

const fixtures = new URL("./fixtures/blog/", import.meta.url).pathname;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const [fixture] = loadArticles(fixtures);
const TODAY = "2026-10-21";

// Artículo en memoria; recalcula el hash de aprobación para que sea coherente.
function article(patch = {}, body = "Texto de prueba.", { approved = true, fixtureFlag = false } = {}) {
  const meta = { ...fixture.meta, slug: "tema-real", ...patch };
  if (!fixtureFlag) delete meta.fixture;
  if (approved) meta.approval = { ...meta.approval, content_sha256: contentHash(meta, body) };
  else {
    meta.review_status = patch.review_status ?? "in_review";
    delete meta.approval;
    delete meta.approved_at;
  }
  return { meta, body };
}
const text = ({ meta, body }) => `---\n${JSON.stringify(meta)}\n---\n${body}`;
const parse = (art, options = {}) => parseSource(text(art), "t.md", { today: TODAY, ...options });

// ---- Plantilla (solo español, SEO, estructura) ----------------------------------------
test("la plantilla es solo español: sin hreflang, selector ni language.js", () => {
  for (const html of [renderArticle(fixture), renderIndex([fixture], { includeFixtures: true })]) {
    assert.match(html, /<html lang="es">/);
    assert.doesNotMatch(html, /hreflang/);
    assert.doesNotMatch(html, /language-switch|language\.js/);
    assert.doesNotMatch(html, /\/en\//);
    assert.match(html, /og:locale" content="es_ES"/);
  }
});

test("canonical propio, og:url y breadcrumbs coherentes", () => {
  const html = renderArticle(fixture);
  const url = "https://legalprevent.com/blog/articulo-de-prueba/";
  assert.deepEqual([...html.matchAll(/rel="canonical" href="([^"]+)"/g)].map((m) => m[1]), [url]);
  assert.match(html, new RegExp(`og:url" content="${url}"`));
  assert.match(renderIndex([]), /rel="canonical" href="https:\/\/legalprevent\.com\/blog\/"/);
});

test("el artículo aprobado muestra autoría, fechas y responsable de revisión", () => {
  const html = renderArticle(fixture);
  assert.match(html, /Equipo Jurídico de LegalPrevent/);
  assert.match(html, /<time datetime="2026-10-01">01\/10\/2026<\/time>/);
  assert.match(html, /<time datetime="2026-10-15">15\/10\/2026<\/time>/);
  assert.match(html, /Luis Martín Grecco, abogado/);
  assert.match(html, /"reviewedBy"/);
});

test("las fuentes muestran su estado normativo y el contenido se escapa", () => {
  const html = renderArticle(fixture);
  assert.match(html, /Vigente\. Consultada el 14\/10\/2026/);
  assert.match(html, /Proyecto \(no vigente\)/);
  assert.match(html, /&lt;etiquetas&gt; &amp; símbolos/);
  assert.doesNotMatch(html, /<etiquetas>/);
});

test("el JSON-LD es válido y contiene Article, WebPage y BreadcrumbList", () => {
  const json = JSON.parse(renderArticle(fixture).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(json["@graph"].map((n) => n["@type"]), ["Article", "WebPage", "BreadcrumbList"]);
  assert.equal(json["@graph"][0].author.name, "Equipo Jurídico de LegalPrevent");
});

test("la salida es determinista", () => {
  assert.deepEqual([...renderAll([fixture], { includeFixtures: true })], [...renderAll([fixture], { includeFixtures: true })]);
});

// ---- 1. Solo los artículos aprobados generan salida pública ---------------------------
test("draft e in_review no generan HTML público ni aparecen en el índice", () => {
  for (const status of ["draft", "in_review"]) {
    const borrador = article({ slug: "borrador-secreto", title: "Borrador secreto", review_status: status }, "x", { approved: false });
    const files = renderAll([article(), borrador]);
    assert.deepEqual([...files.keys()].sort(), ["blog/index.html", "blog/tema-real/index.html"]);
    assert.doesNotMatch(files.get("blog/index.html"), /Borrador secreto/);
    assert.throws(() => renderArticle(borrador), /sin aprobar no genera HTML público/);
  }
});

test("la vista previa de un borrador es solo explícita: sin revisor y con noindex", () => {
  const html = renderArticle(article({}, "x", { approved: false }), { preview: true });
  assert.doesNotMatch(html, /reviewedBy|Luis Martín Grecco/);
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.match(html, /Pendiente de aprobación/);
});

test("checkOutput detecta HTML sobrante de artículos no aprobados o inexistentes", () => {
  const root = mkdtempSync(join(tmpdir(), "blog-"));
  const files = renderAll([article()]);
  for (const [path, html] of files) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), html);
  }
  assert.deepEqual(checkOutput(root, files), []);
  mkdirSync(join(root, "blog/borrador-secreto"), { recursive: true });
  writeFileSync(join(root, "blog/borrador-secreto/index.html"), "<html></html>");
  assert.deepEqual(checkOutput(root, files), ["Sobrante (no corresponde a un artículo aprobado): blog/borrador-secreto/index.html"]);
  writeFileSync(join(root, "blog/tema-real/index.html"), "alterado");
  assert.match(checkOutput(root, files).join("\n"), /Desfase: blog\/tema-real\/index\.html/);
});

// ---- 2. Aprobación verificable ---------------------------------------------------------
test("la aprobación ya no es un texto libre: approved_by se rechaza", () => {
  assert.throws(() => parse(article({ approved_by: REVIEWER.name })), /approved_by ya no se admite/);
});

test("un artículo aprobado necesita el bloque approval bien formado", () => {
  const sin = article();
  delete sin.meta.approval;
  assert.throws(() => parse(sin), /approval\.pr/);
  for (const approval of [
    { pr: 0, commit: "a".repeat(40) },
    { pr: 1.5, commit: "a".repeat(40) },
    { pr: 1, commit: "abc" },
    { pr: 1, commit: "A".repeat(40) },
  ]) {
    const base = article();
    base.meta.approval = { ...approval, content_sha256: contentHash(base.meta, base.body) };
    assert.throws(() => parse(base), /approval\.(pr|commit)/);
  }
  const corto = article();
  corto.meta.approval.content_sha256 = "abc";
  assert.throws(() => parse(corto), /content_sha256/);
});

test("cualquier cambio del contenido tras la aprobación invalida el hash", () => {
  const aprobado = article();
  assert.doesNotThrow(() => parse(aprobado));
  assert.throws(() => parse({ ...aprobado, body: aprobado.body + " Añadido." }), /cambió después de la aprobación/);
  assert.throws(() => parse({ ...aprobado, meta: { ...aprobado.meta, title: "Otro título" } }), /cambió después de la aprobación/);
  assert.throws(() => parse({ ...aprobado, meta: { ...aprobado.meta, date_modified: "2026-10-16", approved_at: "2026-10-16" } }), /cambió después/);
});

test("el hash ignora los campos de aprobación y normaliza saltos de línea", () => {
  const { meta, body } = article();
  const base = contentHash(meta, body);
  assert.equal(contentHash({ ...meta, review_status: "in_review", approved_at: undefined, approval: undefined }, body), base);
  assert.equal(contentHash(meta, body.replace(/\n/g, "\r\n") + "\n"), base);
});

test("un artículo sin aprobar no puede llevar approval ni approved_at", () => {
  const borrador = article({}, "x", { approved: false });
  assert.doesNotThrow(() => parse(borrador));
  assert.throws(() => parse({ ...borrador, meta: { ...borrador.meta, approved_at: "2026-10-15" } }), /sin aprobar/);
  assert.throws(() => parse({ ...borrador, meta: { ...borrador.meta, approval: fixture.meta.approval } }), /sin aprobar/);
});

const review = (state, commit, login = "martingrelu") => ({ state, commit_id: commit, user: { login } });
const COMMIT = "a".repeat(40);
const sealed = () => {
  const art = article();
  art.meta.approval.commit = COMMIT;
  art.meta.approval.content_sha256 = contentHash(art.meta, art.body);
  return art;
};

test("verifyApprovalRecord acepta la revisión APPROVED del responsable sobre el commit correcto", () => {
  const art = sealed();
  assert.equal(verifyApprovalRecord(art, [review("COMMENTED", COMMIT), review("APPROVED", COMMIT)], "martingrelu", art.meta.approval.content_sha256).ok, true);
  assert.equal(verifyApprovalRecord(art, [review("APPROVED", COMMIT, "MartinGrelu")], "martingrelu", art.meta.approval.content_sha256).ok, true);
});

test("verifyApprovalRecord rechaza aprobaciones ajenas, anuladas, de otro commit o con contenido distinto", () => {
  const art = sealed();
  const hash = art.meta.approval.content_sha256;
  const fails = (reviews, h = hash) => verifyApprovalRecord(art, reviews, "martingrelu", h);
  assert.match(fails([]).reason, /no ha revisado/);
  assert.match(fails([review("APPROVED", COMMIT, "otra-persona")]).reason, /no ha revisado/);
  assert.match(fails([review("COMMENTED", COMMIT)]).reason, /no ha revisado/);
  assert.match(fails([review("APPROVED", COMMIT), review("CHANGES_REQUESTED", COMMIT)]).reason, /CHANGES_REQUESTED/);
  assert.match(fails([review("APPROVED", COMMIT), review("DISMISSED", COMMIT)]).reason, /DISMISSED/);
  assert.match(fails([review("APPROVED", "b".repeat(40))]).reason, /otro commit/);
  assert.match(fails([review("APPROVED", COMMIT)], "0".repeat(64)).reason, /no coincide/);
  assert.equal(verifyApprovalRecord(article({}, "x", { approved: false }), [], "martingrelu", hash).ok, false);
});

test("la configuración del responsable coincide con la firma de revisión", () => {
  const approvers = JSON.parse(read("seo-engine/approvers.json"));
  assert.equal(approvers.reviewer_name, REVIEWER.name);
  assert.match(approvers.reviewer_github, /^[A-Za-z0-9-]+$/);
});

// ---- 3. Fechas y enlaces ---------------------------------------------------------------
test("las fechas deben existir en el calendario y no ser futuras", () => {
  for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "26-10-01", "2026-1-1", "", null]) {
    assert.equal(isCalendarDate(bad), false, String(bad));
  }
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("2027-02-29"), false);
  for (const key of ["date_published", "date_modified"]) {
    assert.throws(() => parse(article({ [key]: "2026-02-31" })), new RegExp(`${key} debe ser una fecha real`));
  }
  assert.throws(() => parse(article({ date_published: "2026-10-22", date_modified: "2026-10-22", approved_at: "2026-10-22" })), /no puede ser futura/);
  assert.throws(() => parse(article({ date_modified: "2026-09-01" })), /date_modified anterior/);
  assert.throws(() => parse(article({ approved_at: "2026-10-14" })), /approved_at anterior a date_modified/);
  assert.throws(() => parse(article({ approved_at: "2026-10-30" }), { today: "2026-10-21" }), /approved_at no puede ser futura/);
  const fuentes = (consulted_at) => article({ sources: [{ title: "x", url: "https://www.boe.es/", status: "vigente", consulted_at }] });
  assert.throws(() => parse(fuentes("2026-02-30")), /consulted_at/);
  assert.throws(() => parse(fuentes("2027-01-01")), /consulted_at/);
});

test("los enlaces Markdown inseguros se rechazan en lugar de renderizarse", () => {
  const inseguros = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,AAAA",
    "http://www.boe.es/",
    "//evil.example/x",
    "https://usuario:clave@www.boe.es/",
    "https://localhost/",
    "https://www.boe.es/ con espacio",
    "/../secreto",
    "/en/partner/",
    "/en",
    "ftp://x.es/",
    "mailto:a@b.es",
    "",
  ];
  for (const target of inseguros) {
    assert.throws(() => parse(article({}, `Texto [enlace](${target}) más texto.`)), /enlace rechazado/, target);
    assert.notEqual(linkProblem(target), null, target);
  }
  for (const target of ["https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673&p=20240101", "/partner/", "/diagnostico/#contacto", "/blog/otro-articulo/"]) {
    assert.equal(linkProblem(target), null, target);
    assert.doesNotThrow(() => parse(article({}, `Texto [enlace](${target}).`)), target);
  }
});

test("las URLs de las fuentes deben ser https seguras", () => {
  for (const url of ["http://www.boe.es/", "javascript:alert(1)", "https://u:p@www.boe.es/", "/relativa/", "https://sin-punto/"]) {
    const art = article({ sources: [{ title: "x", url, status: "vigente", consulted_at: "2026-10-14" }] });
    assert.throws(() => parse(art), /url de fuente rechazada/, url);
  }
});

test("el renderizado escapa los enlaces válidos con & en la URL", () => {
  const art = article({}, "Ver [BOE](https://www.boe.es/a?x=1&y=2).");
  const html = renderArticle(parse(art));
  assert.match(html, /<a href="https:\/\/www\.boe\.es\/a\?x=1&amp;y=2">BOE<\/a>/);
});

test("parseRaw/parseSource rechazan fuentes sin bloque JSON", () => {
  assert.throws(() => parseSource("sin front matter"), /bloque JSON/);
  assert.throws(() => parseRaw("---\n{no es json}\n---\nx"), /JSON válido/);
  assert.throws(() => parse(article({ slug: "Mal Slug" })), /slug/);
  assert.throws(() => parse(article({ review_status: "publicado" })), /review_status/);
});

// ---- 5. El artículo ficticio de pruebas nunca se publica -------------------------------
test("el fixture está marcado y no genera salida salvo que un test lo pida expresamente", () => {
  assert.equal(fixture.meta.fixture, true);
  assert.deepEqual([...renderAll([fixture]).keys()], ["blog/index.html"]);
  assert.doesNotMatch(renderAll([fixture]).get("blog/index.html"), /Artículo de prueba/);
  assert.ok(renderAll([fixture], { includeFixtures: true }).has("blog/articulo-de-prueba/index.html"));
});

test("la CLI solo lee content/blog: el fixture no está ahí ni se publica", () => {
  assert.deepEqual(
    [...renderAll(loadArticles(new URL("../content/blog", import.meta.url).pathname)).keys()].filter((p) => p !== "blog/index.html"),
    []
  );
  assert.throws(() => read("content/blog/articulo-de-prueba.md"));
});

test("la allowlist de Pages nunca incluye el fixture, tests, seo-engine ni content", () => {
  const allowlist = read(".github/pages-allowlist.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const path of allowlist) {
    assert.doesNotMatch(path, /articulo-de-prueba|fixtures|^tests\/|^seo-engine\/|^content\//, path);
  }
  // Cuando existan artículos: cada ruta blog/ publicada debe salir del renderizado de artículos aprobados.
  const generated = renderAll(loadArticles(new URL("../content/blog", import.meta.url).pathname));
  for (const path of allowlist.filter((p) => p.startsWith("blog/"))) {
    assert.ok(generated.has(path), `${path} está en la allowlist pero no es un artículo aprobado`);
  }
});

test("el sitemap y producción no cambian: nada del blog publicado", () => {
  assert.doesNotMatch(read("sitemap.xml"), /\/blog\/|articulo-de-prueba/);
  assert.doesNotMatch(read("tools/build-i18n.mjs"), /blog/);
  assert.doesNotMatch(read(".github/workflows/pages.yml"), /blog|seo-engine|content\//);
});
