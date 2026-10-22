// Comprobación estática del workflow blog-ci.yml: permisos mínimos, solo lectura, sin secretos ni
// token de la API, acciones fijadas por SHA y sin entradas no confiables en los pasos `run`.
// Además comprueba que el despliegue de producción (pages.yml) y la allowlist no cambian.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ci = read(".github/workflows/blog-ci.yml");
const jobBlock = (name) => ci.split(/^  (?=[a-z]+:\n)/m).find((block) => block.startsWith(`${name}:`));

test("solo se dispara con pull_request y push a main (nunca pull_request_target ni eventos de revisión)", () => {
  assert.match(ci, /^on:\n  pull_request:\n/m);
  assert.match(ci, /^  push:\n    branches: \[main\]/m);
  assert.doesNotMatch(ci, /pull_request_target|pull_request_review|workflow_run|workflow_dispatch|schedule:|issue_comment/);
});

test("permisos: vacíos por defecto y solo contents: read en cada job (sin API de GitHub)", () => {
  assert.match(ci, /^permissions: \{\}/m);
  const allPermissions = [...ci.matchAll(/^\s+([a-z-]+): (read|write|none)\s*(?:#.*)?$/gm)];
  assert.equal(allPermissions.length, 2);
  for (const [, scope, level] of allPermissions) {
    assert.equal(scope, "contents");
    assert.equal(level, "read");
  }
  assert.doesNotMatch(ci, /: write\b|id-token|pull-requests|statuses|checks|actions:|deployments/);
});

test("no usa secretos ni token: solo la variable pública con la huella de la clave", () => {
  assert.doesNotMatch(ci, /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/);
  const references = [...ci.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual(references.sort(), ["github.event.pull_request.number || github.ref", "vars.BLOG_APPROVER_FINGERPRINT"]);
  // La variable solo llega al paso de verificación, no al job de tests.
  assert.doesNotMatch(jobBlock("tests"), /BLOG_APPROVER_FINGERPRINT|vars\./);
  assert.match(jobBlock("approval"), /BLOG_APPROVER_FINGERPRINT: \$\{\{ vars\.BLOG_APPROVER_FINGERPRINT \}\}/);
});

test("las acciones están fijadas por SHA, sin credenciales persistentes", () => {
  const uses = [...ci.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, action);
  const checkouts = ci.match(/actions\/checkout@/g).length;
  assert.equal(ci.match(/persist-credentials: false/g).length, checkouts);
});

test("ningún paso interpola texto controlable por el autor de la PR", () => {
  for (const run of ci.matchAll(/run: [|>]?\s*([\s\S]*?)(?=\n\s+- |\n\s+[a-z-]+:|\n\n|$)/g)) {
    assert.doesNotMatch(run[1], /\$\{\{/, run[1]);
  }
  assert.doesNotMatch(ci, /github\.event\.(pull_request\.(title|body|head\.ref|head\.label)|review\.body|comment)/);
  assert.doesNotMatch(ci, /head_ref|github\.head_ref/);
});

test("los jobs tienen tiempo límite, no tienen filtro de rutas y ejecutan los scripts del blog", () => {
  assert.equal(ci.match(/timeout-minutes: 10/g).length, 2);
  assert.doesNotMatch(ci, /\bpaths(-ignore)?:/);
  assert.match(ci, /node --test tests\/\*\.mjs/);
  assert.match(ci, /node seo-engine\/blog-render\.mjs --check/);
  assert.match(ci, /node seo-engine\/verify-approval\.mjs/);
});

test("el workflow no publica ni escribe: sin deploy, push, commit ni llamadas de escritura", () => {
  assert.doesNotMatch(ci, /deploy-pages|upload-pages-artifact|git push|git commit|gh pr|gh api|curl|-X (POST|PUT|PATCH|DELETE)/);
});

test("producción no cambia: pages.yml sigue publicando solo la allowlist y esta no incluye el blog ni la CI", () => {
  const pages = read(".github/workflows/pages.yml");
  assert.match(pages, /branches: \[main\]/);
  assert.match(pages, /pages-allowlist\.txt/);
  assert.doesNotMatch(pages, /blog|seo-engine|content\//);
  const allowlist = read(".github/pages-allowlist.txt");
  assert.doesNotMatch(allowlist, /seo-engine|content\/|docs\/blog-approval|workflows\/blog-ci|approvals|allowed_signers/);
  const blogLines = allowlist.split("\n").filter((l) => /blog/.test(l) && !l.startsWith("#"));
  assert.ok(blogLines.every((l) => l.startsWith("blog/")), "el blog solo entra como rutas blog/ generadas");
});
