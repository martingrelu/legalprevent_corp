// Separación entre las fuentes oficiales y el contenido generado por IA (seo-engine/sources/separation.mjs).
// Un borrador generado solo puede tocar su propio artículo en draft/in_review: nunca el registro de fuentes, los
// reconocimientos de revisión, la aprobación, las firmas ni el código o la CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATOR_BRANCH_PREFIX, originOf, separationProblems } from "../seo-engine/sources/separation.mjs";

const article = (meta = {}, body = "Texto.") =>
  `---\n${JSON.stringify({ slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "draft", ...meta })}\n---\n${body}`;
const problems = (changes, origin = "generator") => separationProblems({ origin, changes });
const draft = (path = "content/blog/tema.md", patch = {}, before = null) => ({ path, before, after: article(patch) });

test("el origen se decide por el AUTOR: nada que no sea del responsable se trata como humano, sea cual sea el nombre de la rama", () => {
  const human = "martingrelu";
  assert.equal(originOf({ author: "martingrelu", humanLogin: human, branch: "feat/blog-plantilla" }), "human");
  assert.equal(originOf({ author: "MartinGrelu", humanLogin: human, branch: "main" }), "human", "sin distinguir mayúsculas");
  // Un bot o cualquier otro autor es generador aunque llame a su rama como una rama humana (el nombre se puede falsear).
  for (const author of ["legalprevent-seo-bot", "dependabot[bot]", "otra-persona", "", undefined, null]) {
    assert.equal(originOf({ author, humanLogin: human, branch: "feat/blog-plantilla" }), "generator", String(author));
  }
  assert.equal(originOf({ author: "martingrelu", humanLogin: human, branch: "seo/borrador" }), "generator", "una rama del motor, incluso del responsable, se trata como generada");
  assert.equal(originOf({ author: "martingrelu", humanLogin: undefined, branch: "x" }), "generator", "sin responsable configurado, denegar por defecto");
  assert.equal(GENERATOR_BRANCH_PREFIX, "seo/");
});

test("un borrador generado puede crear y editar su artículo en draft o in_review, con citas y candados", () => {
  assert.deepEqual(problems([draft()]), []);
  assert.deepEqual(problems([draft("content/blog/tema.md", { review_status: "in_review" }, article())]), []);
  const withCitations = draft("content/blog/tema.md", { citations: [{ id: "c1", source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, lock: { engine: "boe-api-v1" } }] });
  assert.deepEqual(problems([withCitations]), [], "los candados los produce y autentica el verificador, no el modelo");
});

test("un borrador generado no puede tocar el registro de fuentes, las firmas, el código, la CI ni lo publicado", () => {
  for (const path of [
    "content/sources/registry.json",
    "content/blog/approvals/tema/20261021T100000Z-approve-aaaaaaaa.json",
    "seo-engine/sources/verify-citations.mjs",
    "seo-engine/allowed_signers",
    ".github/workflows/blog-ci.yml",
    ".github/pages-allowlist.txt",
    "blog/tema/index.html",
    "tests/blog-signature.test.mjs",
    "docs/blog-sources.md",
    "index.html",
    "content/blog/../sources/registry.json",
    "content/blog/subcarpeta/tema.md",
    "content/blog/Tema.md",
  ]) {
    const result = problems([{ path, before: null, after: "contenido" }]);
    assert.match(result.join(), /solo puede tocar content\/blog\/<slug>\.md/, path);
  }
});

test("un borrador generado no puede aprobar, reconocer revisiones ni tocar un artículo aprobado", () => {
  assert.match(problems([draft("content/blog/tema.md", { review_status: "approved", approved_at: "2026-10-21" })]).join(), /no puede dejar el artículo en "approved"/);
  assert.match(problems([draft("content/blog/tema.md", { approved_at: "2026-10-21" })]).join(), /no puede añadir ni cambiar "approved_at"/);
  assert.match(problems([draft("content/blog/tema.md", { approval: { pr: 1, content_sha256: "a".repeat(64) } })]).join(), /no puede añadir ni cambiar "approval"/);
  assert.match(problems([draft("content/blog/tema.md", { review_ack: [{ citation: "c1", reason: "solo_existencia", note: "Reconocimiento hecho por la IA." }] })]).join(), /no puede añadir ni cambiar "review_ack"/);
  // Modificar o borrar un reconocimiento existente también está prohibido.
  const acked = article({ review_status: "in_review", review_ack: [{ citation: "c1", reason: "solo_existencia", note: "Reconocimiento humano previo." }] });
  assert.match(problems([{ path: "content/blog/tema.md", before: acked, after: article({ review_status: "in_review" }) }]).join(), /review_ack/);
  assert.deepEqual(problems([{ path: "content/blog/tema.md", before: acked, after: acked.replace("Texto.", "Texto retocado.") }]), [], "el texto sí puede cambiar mientras no toque el reconocimiento");
  // Un artículo ya aprobado no se edita ni se borra desde un borrador.
  const approved = article({ review_status: "approved", approved_at: "2026-10-21" });
  assert.match(problems([{ path: "content/blog/tema.md", before: approved, after: approved.replace("Texto.", "Otro.") }]).join(), /no se puede modificar ni borrar un artículo aprobado/);
  assert.match(problems([{ path: "content/blog/tema.md", before: approved, after: null }]).join(), /no se puede modificar ni borrar un artículo aprobado/);
});

test("un front matter ilegible se rechaza, un borrador sin aprobar se puede borrar y los cambios humanos no se restringen aquí", () => {
  assert.match(problems([{ path: "content/blog/tema.md", before: null, after: "sin front matter" }]).join(), /front matter válido/);
  assert.deepEqual(problems([{ path: "content/blog/tema.md", before: article(), after: null }]), []);
  assert.deepEqual(problems([{ path: "content/sources/registry.json", before: "{}", after: "{ }" }], "human"), []);
  assert.deepEqual(problems([draft()], "human"), []);
  assert.deepEqual(problems([]), []);
  const mixed = problems([draft(), { path: "content/sources/registry.json", before: "{}", after: "{ }" }]);
  assert.equal(mixed.length, 1, "un único cambio prohibido basta para marcar la PR entera");
});

test("un borrador generado solo puede añadir ficheros regulares: enlaces simbólicos, submódulos y ejecutables se rechazan", () => {
  for (const mode of ["120000", "160000", "100755"]) {
    const found = problems([{ path: "content/blog/tema.md", before: null, after: article(), mode }]);
    assert.equal(found.length, 1, mode);
    assert.match(found[0], new RegExp(mode));
  }
  assert.deepEqual(problems([{ path: "content/blog/tema.md", before: null, after: article(), mode: "100644" }]), []);
  assert.deepEqual(problems([{ path: "content/blog/tema.md", before: article(), after: null, mode: undefined }]), [], "borrar su propio borrador no es un fichero especial");
});
