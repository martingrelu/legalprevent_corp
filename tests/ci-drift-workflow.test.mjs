// Análisis estático de sources-drift.yml: solo lectura, sin secretos, sin escritura, sin disparadores de PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../.github/workflows/sources-drift.yml", import.meta.url), "utf8");
const wf = raw.replace(/^\s*#.*$/gm, "").replace(/\s+#[^\n"']*$/gm, "");

test("solo se dispara por calendario o a mano; nunca por PR, push ni comentarios", () => {
  assert.match(wf, /^on:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch: \{\}/m);
  assert.doesNotMatch(wf, /pull_request|pull_request_target|push:|issue_comment|workflow_run|repository_dispatch|release:/);
  const cron = wf.match(/cron: "([^"]+)"/)[1].split(" ");
  assert.equal(cron.length, 5);
  assert.doesNotMatch(cron[0] + cron[1], /\*/, "no se ejecuta cada minuto ni cada hora");
});

test("permisos de solo lectura, sin secretos ni token de la API, y sin pasos que escriban", () => {
  assert.match(wf, /^permissions: \{\}/m);
  const perms = [...wf.matchAll(/^\s+([a-z-]+): (read|write|none)\s*$/gm)];
  assert.deepEqual(perms.map((m) => [m[1], m[2]]), [["contents", "read"]]);
  assert.doesNotMatch(wf, /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|id-token|environment:|: write\b|issues:|pull-requests|statuses|checks:|actions:|deployments|packages:/);
  assert.doesNotMatch(wf, /git (push|commit|tag)|gh (issue|pr|api|release)|upload-artifact|create-issue|curl|wget/);
});

test("solo ejecuta node sobre código del repositorio y una acción fijada por SHA; las variables llegan por entorno", () => {
  const uses = [...wf.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.deepEqual(uses.length, 1);
  assert.match(uses[0], /^actions\/checkout@[0-9a-f]{40}$/);
  assert.match(wf, /persist-credentials: false/);
  const runs = [...wf.matchAll(/^\s+run: (?:\|\n((?:\s{10}.+\n)+)|(.+)\n)/gm)].flatMap((m) => (m[1] ?? m[2]).split("\n").map((l) => l.trim()).filter(Boolean));
  assert.ok(runs.every((line) => /^node( |$)/.test(line)), `solo node: ${runs}`);
  assert.ok(runs.includes("node seo-engine/ci/check-drift.mjs"));
  for (const match of wf.matchAll(/run: (?:\|\n(?:\s{10}.*\n)+|.+\n)/g)) assert.doesNotMatch(match[0], /\$\{\{/);
  const expressions = [...wf.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual(expressions, ["vars.BLOG_APPROVER_FINGERPRINT"]);
  assert.match(wf, /timeout-minutes: \d+/);
  assert.doesNotMatch(wf, /LIVE_MODE|continue-on-error/);
});

test("no toca el despliegue: pages.yml y la allowlist no lo mencionan", () => {
  assert.doesNotMatch(readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"), /drift|seo-engine/);
  assert.doesNotMatch(readFileSync(new URL("../.github/pages-allowlist.txt", import.meta.url), "utf8"), /drift|\.github|seo-engine|content\//);
});
