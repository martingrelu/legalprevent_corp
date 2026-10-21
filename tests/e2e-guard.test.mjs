// SOLO EN LA RAMA DE PRUEBA test/blog-signature-e2e. Garantiza que el artículo ficticio de la
// prueba de integración no pueda llegar a GitHub Pages ni mezclarse con contenido real.
// Debe eliminarse con la rama; no forma parte de ninguna PR hacia main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const SLUG = "prueba-firma-e2e";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const allowlist = read(".github/pages-allowlist.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

test("la allowlist de Pages no incluye nada del artículo ficticio ni de blog/, content/ o approvals", () => {
  for (const path of allowlist) {
    assert.doesNotMatch(path, new RegExp(`${SLUG}|^blog/|^content/|approvals|allowed_signers`), path);
  }
});

test("simulación del bucle de pages.yml: lo publicable no contiene ningún fichero del artículo ficticio", () => {
  const published = allowlist.filter((path) => exists(path));
  assert.equal(published.length, allowlist.length, "todo lo de la allowlist existe");
  assert.equal(published.filter((path) => path.includes(SLUG)).length, 0);
  assert.equal(published.filter((path) => /^(blog|content|seo-engine|tests|docs)\//.test(path)).filter((p) => p !== "docs/pr2/eval/bateria-v1.json").length, 0);
});

test("los ficheros de la prueba están solo en las rutas previstas", () => {
  const expected = new Set([`content/blog/${SLUG}.md`]);
  const approvals = `content/blog/approvals/${SLUG}`;
  if (exists(approvals)) for (const f of readdirSync(new URL(`../${approvals}`, import.meta.url))) expected.add(`${approvals}/${f}`);
  assert.ok(exists(`content/blog/${SLUG}.md`));
  // content/blog solo contiene el artículo ficticio y su carpeta de aprobaciones: no hay contenido real mezclado.
  const entries = readdirSync(new URL("../content/blog", import.meta.url)).sort();
  assert.deepEqual(entries.filter((e) => e !== "approvals"), [`${SLUG}.md`]);
  if (exists("content/blog/approvals")) assert.deepEqual(readdirSync(new URL("../content/blog/approvals", import.meta.url)), [SLUG]);
  // blog/ (HTML generado, solo si el artículo está aprobado) solo contiene el índice y el artículo ficticio.
  if (exists("blog")) assert.deepEqual(readdirSync(new URL("../blog", import.meta.url)).sort(), ["index.html", SLUG]);
});

test("el artículo ficticio está marcado como prueba en título y cuerpo", () => {
  const source = read(`content/blog/${SLUG}.md`);
  assert.match(source, /"title": "PRUEBA - NO PUBLICAR/);
  assert.match(source, /## PRUEBA - NO PUBLICAR/);
});
