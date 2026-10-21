// check-drift.mjs como lo ejecuta el workflow programado: un árbol de `main` con un artículo PUBLICADO (aprobado con firma
// real), `fetch` sustituido por las respuestas del INSST (ok / cambiada / caída) y comprobación de los códigos de salida.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAMESPACE, buildRecord, recordFileName, signStatement, statementFor } from "../seo-engine/approval-signature.mjs";
import { contentHash, parseSource } from "../seo-engine/blog-render.mjs";
import { bindingFor, lockCutoff } from "../seo-engine/sources/exceptions.mjs";
import { DAY, IDENTITY, articleWith, genKey, insst, iso, registry, signedRecord, webLockAt } from "./helpers/exceptions-fixture.mjs";
import { ROOT, outputProblems } from "./helpers/ci-repo.mjs";

const work = mkdtempSync(join(tmpdir(), "lp-drift-"));
const fx = (n) => readFileSync(new URL(`./fixtures/web/${n}`, import.meta.url), "utf8");
const preload = join(work, "fake-web.mjs");
writeFileSync(preload, `import { appendFileSync } from "node:fs";
const html = ${JSON.stringify(fx("insst-ficha-simplificacion.html"))};
const robots = ${JSON.stringify(fx("robots-insst.txt"))};
const canonical = ${JSON.stringify(insst.urls.canonical)};
const document = ${JSON.stringify(insst.urls.document)};
globalThis.fetch = async (url) => {
  url = String(url);
  appendFileSync(process.env.FETCH_LOG, url + "\\n");
  const mode = process.env.DRIFT_WEB;
  if (mode === "down") return new Response("error", { status: 503 });
  if (url.endsWith("/robots.txt")) return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
  if (url === canonical) return new Response(mode === "changed" ? html.replace(/<h1([^>]*)>([^<]+)/, "<h1$1>$2 (actualizado)") : html, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
  if (url === document) return new Response("%PDF-1.4 sintético", { status: 200, headers: { "content-type": "application/pdf" } });
  return new Response("", { status: 404 });
};\n`);

const today = new Date().toISOString().slice(0, 10);
const lock = await webLockAt(insst, new Date());
const citations = (n = 1) => Array.from({ length: n }, (_, i) => ({ id: `g${i + 1}`, source: insst.id, type: "criterio", locator: { section: "Resumen" }, lock }));
let seq = 0;

// Árbol de `main`: artículo aprobado y firmado (o sin firmar), registro, clave y, opcionalmente, una excepción firmada.
function tree({ n = 1, signed = true, key = genKey("approver"), drafts = [], exception = false, corruptArticle = false, noRegistry = false } = {}) {
  const root = join(work, `repo-${++seq}`);
  mkdirSync(join(root, "content/blog/approvals/tema"), { recursive: true });
  mkdirSync(join(root, "content/sources"), { recursive: true });
  mkdirSync(join(root, "seo-engine"), { recursive: true });
  const art = articleWith(citations(n), { approved_at: today });
  writeFileSync(join(root, "content/blog/tema.md"), corruptArticle ? "no es un artículo" : `---\n${JSON.stringify(art.meta)}\n---\n${art.body}`);
  for (const slug of drafts) writeFileSync(join(root, `content/blog/${slug}.md`), `---\n${JSON.stringify({ slug, title: "Borrador", description: "x", date_published: today, date_modified: today, review_status: "draft" })}\n---\nx`);
  if (!noRegistry) writeFileSync(join(root, "content/sources/registry.json"), JSON.stringify(registry));
  writeFileSync(join(root, "seo-engine/allowed_signers"), key.allowedSigners);
  const { meta, body } = parseSource(`---\n${JSON.stringify(art.meta)}\n---\n${art.body}`, "tema.md");
  if (signed) {
    const fields = { action: "approve", slug: "tema", sha256: contentHash(meta, body), timestamp: `${today}T00:00:01Z` };
    const record = buildRecord({ ...fields, identity: IDENTITY, signature: signStatement(statementFor(fields), key.priv) });
    writeFileSync(join(root, "content/blog/approvals/tema", recordFileName(record)), JSON.stringify(record));
  }
  if (exception) {
    mkdirSync(join(root, "content/blog/exceptions/tema"), { recursive: true });
    const binding = bindingFor({ meta, body, citation: meta.citations[0], entry: insst });
    const rec = signedRecord({ binding, issued_at: iso(Math.max(Date.now() - 60_000, Date.parse(`${lock.verified_at}T00:00:00Z`))), expires_at: iso(Math.min(Date.now() + 5 * DAY, lockCutoff(lock) - 1000)), key });
    writeFileSync(join(root, "content/blog/exceptions/tema", rec.file), JSON.stringify(rec.record));
  }
  return { root, key };
}

// Huella de todo el árbol para comprobar que el control no escribe nada.
function snapshot(dir) {
  const out = [];
  const walk = (d) => readdirSync(d).sort().forEach((name) => {
    const p = join(d, name);
    statSync(p).isDirectory() ? walk(p) : out.push(`${p}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
  });
  walk(dir);
  return out.join("\n");
}

function run(t, { web = "ok", env = {}, fingerprint = t.key.fingerprint } = {}) {
  const log = join(work, `fetch-${++seq}.log`);
  const summary = join(work, `summary-${seq}.md`);
  const before = snapshot(t.root);
  const r = spawnSync("node", [join(ROOT, "seo-engine/ci/check-drift.mjs")], {
    cwd: work,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH, REPO_DIR: t.root, NODE_OPTIONS: `--import=${preload}`, FETCH_LOG: log, DRIFT_WEB: web, LIVE_ATTEMPTS: "1", GITHUB_STEP_SUMMARY: summary, ...(fingerprint ? { BLOG_APPROVER_FINGERPRINT: fingerprint } : {}), ...env },
  });
  const after = snapshot(t.root);
  let urls = [];
  try { urls = readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { /* sin red */ }
  return { ...r, urls, readOnly: before === after };
}

test("artículo publicado, aprobación firmada vigente y fuente coincidente: exit 0, solo lectura", () => {
  const r = run(tree());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /drift: CORRECTO/);
  assert.ok(r.urls.every((u) => new URL(u).hostname === "www.insst.es"), r.urls.join());
  assert.equal(r.readOnly, true, "el control no escribe en el árbol");
  assert.deepEqual(outputProblems(r.stdout), []);
});

test("la fuente cambió: exit 1 y REVISION_JURIDICA_NECESARIA", () => {
  const r = run(tree(), { web: "changed" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /REVISIÓN JURÍDICA NECESARIA/);
  assert.match(r.stdout, /REVISION_JURIDICA_NECESARIA/);
  assert.match(r.stdout, /changed/);
  assert.equal(r.readOnly, true);
});

test("la fuente no responde: exit 3 (INCONCLUSO), nunca 0, con aviso explícito; una excepción firmada NO lo tapa", () => {
  const plain = run(tree(), { web: "down" });
  assert.equal(plain.status, 3, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /drift: INCONCLUSO/);
  assert.match(plain.stdout, /NO es un resultado satisfactorio/);
  const withException = run(tree({ exception: true }), { web: "down" });
  assert.equal(withException.status, 3, withException.stdout);
  assert.doesNotMatch(withException.stdout, /REVISION_EXCEPCIONAL/);
});

test("aprobación inválida (sin firma, huella no fijada o de otra clave): exit 1 aunque las citas coincidan", () => {
  assert.equal(run(tree({ signed: false })).status, 1);
  const t = tree();
  assert.equal(run(t, { fingerprint: "" }).status, 1, "sin huella fijada");
  assert.equal(run(t, { fingerprint: genKey("otra").fingerprint }).status, 1, "huella de otra clave");
  const r = run(t, { fingerprint: "" });
  assert.match(r.stdout, /aprobacion/);
});

test("sin artículos publicados no se sale a la red (exit 0); los borradores no cuentan", () => {
  const t = tree();
  // Un árbol con solo borradores: se borra el artículo aprobado.
  writeFileSync(join(t.root, "content/blog/tema.md"), `---\n${JSON.stringify({ slug: "tema", title: "T", description: "x", date_published: today, date_modified: today, review_status: "draft" })}\n---\nx`);
  const r = run(t);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.urls, []);
  assert.match(r.stdout, /nada que comprobar/);
});

test("entradas inválidas o árbol roto fallan cerrado (exit 1), sin red", () => {
  for (const env of [{ LIVE_ATTEMPTS: "0" }, { LIVE_ATTEMPTS: "9" }, { LIVE_ATTEMPTS: "x" }, { DRIFT_MAX_CITATIONS: "0" }, { DRIFT_MAX_CITATIONS: "999" }]) {
    const r = run(tree(), { env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.deepEqual(r.urls, [], JSON.stringify(env));
  }
  assert.equal(run(tree({ corruptArticle: true })).status, 1);
  const noReg = run(tree({ noRegistry: true }));
  assert.equal(noReg.status, 1);
  assert.deepEqual(noReg.urls, []);
});

test("presupuesto: lo que no cabe sale como NO_COMPROBADO (exit 1) y no se consulta", () => {
  const r = run(tree({ n: 3 }), { env: { DRIFT_MAX_CITATIONS: "2" } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /NO_COMPROBADO/);
  assert.deepEqual(r.urls, []);
});

test("informe JSON opcional (DRIFT_OUT) y resumen del job; el informe contiene el estado y no secretos", () => {
  const out = join(work, "report.json");
  const r = run(tree(), { web: "changed", env: { DRIFT_OUT: out } });
  assert.equal(r.status, 1);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.articles[0].state, "REVISION_JURIDICA_NECESARIA");
  assert.equal(report.exit, 1);
  assert.doesNotMatch(JSON.stringify(report), /BEGIN SSH|PRIVATE|fingerprint/i);
});
