// Comprobación estática del workflow blog-ci.yml: permisos mínimos, solo lectura, sin secretos
// propios, acciones fijadas por SHA y sin entradas no confiables en los pasos `run`.
// Además comprueba que el despliegue de producción (pages.yml) y la allowlist no cambian.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ci = read(".github/workflows/blog-ci.yml");
const jobBlock = (name) => ci.split(/^  (?=[a-z]+:\n)/m).find((block) => block.startsWith(`${name}:`));

test("solo se dispara con pull_request, pull_request_review y push a main (nunca pull_request_target)", () => {
  assert.match(ci, /^on:\n  pull_request:\n/m);
  assert.match(ci, /^  pull_request_review:\n/m);
  assert.match(ci, /^  push:\n    branches: \[main\]/m);
  assert.doesNotMatch(ci, /pull_request_target|workflow_run|workflow_dispatch|schedule:/);
});

test("permisos: vacíos por defecto y solo lectura en cada job", () => {
  assert.match(ci, /^permissions: \{\}/m);
  const allPermissions = [...ci.matchAll(/^\s+([a-z-]+): (read|write|none)\s*(?:#.*)?$/gm)];
  assert.ok(allPermissions.length >= 3);
  for (const [, scope, level] of allPermissions) assert.equal(level, "read", `${scope}: ${level}`);
  assert.doesNotMatch(ci, /: write\b|id-token|contents: write|pull-requests: write|statuses: write|checks: write/);
  assert.match(jobBlock("approval"), /pull-requests: read/);
  assert.doesNotMatch(jobBlock("tests"), /pull-requests/);
});

test("no usa más secreto que el token de solo lectura del propio workflow", () => {
  assert.doesNotMatch(ci, /secrets\./);
  const references = [...ci.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  for (const reference of references) {
    assert.match(
      reference,
      /^(github\.(token|repository|ref|event\.pull_request\.(number|head\.sha))( \|\| github\.ref)?|github\.event\.pull_request\.number \|\| github\.ref)$/,
      `expresión no esperada: ${reference}`
    );
  }
  // El token solo llega al paso de verificación, no al job de tests.
  assert.doesNotMatch(jobBlock("tests"), /github\.token|GITHUB_TOKEN/);
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
  assert.doesNotMatch(allowlist, /blog|seo-engine|content\/|docs\/blog-approval|workflows\/blog-ci/);
});
