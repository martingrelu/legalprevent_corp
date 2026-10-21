// Análisis estático de blog-trust.yml (pull_request_target) y de TODOS los workflows: demuestra, para lo que se puede
// comprobar sin ejecutarlo en GitHub, las condiciones de ejecución segura:
//   1. no se ejecuta código, scripts, dependencias ni configuración del PR;
//   2. el contenido del PR no se extrae al espacio de trabajo (solo se lee como objetos de git);
//   3. sin secretos ni permisos de escritura;
//   4. sin inyección por rama, título, ruta o metadatos del PR;
//   5. el verificador procede de la rama base, fijada por SHA;
// Lo que depende del comportamiento de GitHub (que pull_request_target use el workflow de la rama base) está documentado en
// docs/blog-trust-ci.md y se comprobará con una PR de prueba controlada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const trustRaw = read("blog-trust.yml");
// Se analiza el código, no los comentarios (que explican las reglas y mencionan las palabras que se prohíben).
const trust = trustRaw.replace(/^\s*#.*$/gm, "").replace(/\s+#[^\n"']*$/gm, "");
const workflows = readdirSync(dir).filter((name) => name.endsWith(".yml"));
const job = (name) => trust.split(/^  (?=[a-z]+:\n)/m).find((block) => block.startsWith(`${name}:`));
// Todas las líneas de comandos que ejecuta el workflow (run de una línea y de varias).
const commandLines = [];
for (const match of trust.matchAll(/^\s+run: (\|\n((?:\s{10}.+\n)+)|.+\n)/gm)) {
  (match[2] ?? match[1]).split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => commandLines.push(line));
}

test("solo blog-trust.yml usa pull_request_target; el resto de workflows no", () => {
  for (const name of workflows) {
    const source = read(name);
    const uses = /pull_request_target/.test(source.replace(/^\s*#.*$/gm, ""));
    assert.equal(uses, name === "blog-trust.yml", `${name}: pull_request_target`);
  }
  assert.match(trust, /^on:\n  pull_request_target:\n    types: \[opened, synchronize, reopened, ready_for_review\]/m);
  assert.doesNotMatch(trust.replace(/^\s*#.*$/gm, ""), /workflow_run|workflow_dispatch|schedule:|issue_comment|pull_request:/);
});

test("el único checkout es el de la rama base, fijado por su SHA, sin credenciales persistentes", () => {
  const checkouts = [...trust.matchAll(/uses: actions\/checkout@([^\s]+)[^\n]*\n\s+with:\n((?:\s{10}.+\n)+)/g)];
  assert.equal(checkouts.length, 2, "uno por job");
  for (const [, version, withBlock] of checkouts) {
    assert.match(version, /^[0-9a-f]{40}$/, "acción fijada por SHA");
    assert.match(withBlock, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "se extrae la rama base");
    assert.match(withBlock, /persist-credentials: false/);
    assert.doesNotMatch(withBlock, /head\.sha|head\.ref|head\.repo|merge|repository:|token:|path:/, "nada del PR en el checkout");
  }
  assert.equal(trust.match(/actions\/checkout@/g).length, 2);
});

test("no se ejecuta nada que venga del PR: ni acciones propias, ni dependencias, ni scripts de otra ruta", () => {
  const uses = [...trust.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.every((action) => /^actions\/checkout@[0-9a-f]{40}$/.test(action)), `acciones permitidas: ${uses}`);
  assert.doesNotMatch(trust, /uses: \.\//, "sin acciones locales (las del PR)");
  assert.doesNotMatch(trust.replace(/^\s*#.*$/gm, ""), /\b(npm|npx|yarn|pnpm|pip|bundle|cargo|make|bash|sh)\b\s|setup-node|cache:|node_modules|package\.json|\.npmrc/);
  const commands = [...trust.matchAll(/^\s+run: node (seo-engine\/ci\/[a-z-]+\.mjs)$/gm)].map((m) => m[1]);
  assert.deepEqual(commands.sort(), ["seo-engine/ci/check-citations.mjs", "seo-engine/ci/check-separation.mjs"]);
  assert.ok(commandLines.length >= 6);
  assert.ok(commandLines.every((line) => /^node( |$)/.test(line)), `solo se ejecuta node: ${commandLines.filter((l) => !/^node( |$)/.test(l))}`);
  assert.ok(commandLines.every((line) => !/[;&|`$<>]|\$\(/.test(line.replace(/'process\.exit\(Number\(process\.versions\.node\.split\("\."\)\[0\]\) >= 20 \? 0 : 1\)'/, ""))), "sin operadores de shell");
});

test("sin secretos, sin token de la API y con permisos de solo lectura", () => {
  assert.doesNotMatch(trust, /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|id-token|environment:/);
  assert.match(trust, /^permissions: \{\}/m);
  const permissions = [...trust.matchAll(/^\s+([a-z-]+): (read|write|none)\s*(?:#.*)?$/gm)];
  assert.equal(permissions.length, 2, "uno por job");
  for (const [, scope, level] of permissions) assert.deepEqual([scope, level], ["contents", "read"]);
  assert.doesNotMatch(trust, /: write\b|pull-requests|statuses|checks|actions:|deployments|issues:|packages:/);
});

test("ningún dato del PR se interpola en un `run`: solo llegan por variables de entorno", () => {
  for (const match of trust.matchAll(/run: (?:\|\n(?:\s{10}.*\n)+|.+\n)/g)) assert.doesNotMatch(match[0], /\$\{\{/, match[0]);
  const expressions = [...trust.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  const allowed = new Set([
    "github.event.pull_request.number",
    "github.event.pull_request.base.sha",
    "github.event.pull_request.head.sha",
    "github.event.pull_request.user.login",
    "github.event.pull_request.head.ref",
  ]);
  for (const expression of expressions) assert.ok(allowed.has(expression), `expresión no permitida: ${expression}`);
  // El título, el cuerpo y las etiquetas del PR no se usan nunca.
  assert.doesNotMatch(trust, /pull_request\.(title|body|labels)|head_ref|head\.label|head\.repo|\.commits|comment|pull_request_review/);
  // Las variables de entorno solo se pasan a los scripts de confianza.
  const envBlocks = [...trust.matchAll(/env:\n((?:\s{10}.+\n)+)\s{8}run: (.+)/g)];
  assert.equal(envBlocks.length, 2);
  for (const [, , command] of envBlocks) assert.match(command, /^node seo-engine\/ci\/check-(separation|citations)\.mjs$/);
});

test("cada job pide solo lo suyo y tiene tiempo límite; los nombres son los de los checks obligatorios", () => {
  for (const name of ["separation", "citations"]) {
    const block = job(name);
    assert.match(block, new RegExp(`name: ${name}\\n`));
    assert.match(block, /timeout-minutes: 10/);
    assert.match(block, /permissions:\n\s+contents: read/);
    assert.match(block, /runs-on: ubuntu-24\.04/);
  }
  assert.match(trust, /concurrency:\n  group: blog-trust-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/);
  assert.doesNotMatch(trust, /\bpaths(-ignore)?:|branches(-ignore)?:/, "sin filtros que permitan saltarse el control");
});

test("el workflow de producción y la allowlist no cambian ni mencionan los controles", () => {
  const pages = read("pages.yml");
  assert.match(pages, /branches: \[main\]/);
  assert.doesNotMatch(pages, /blog-trust|seo-engine|content\//);
  const allowlist = readFileSync(new URL("../.github/pages-allowlist.txt", import.meta.url), "utf8");
  assert.doesNotMatch(allowlist, /blog-trust|seo-engine|content\/|\.github/);
});
