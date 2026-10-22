// `sources-live` como control de CI (check-sources-live.mjs) contra PRs hostiles, con `fetch` sustituido por un registro
// de peticiones: demuestra a qué anfitriones se sale, cuándo NO se sale a la red y que los fallos nunca son éxito.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { makeRepo, outputProblems, runTrusted } from "./helpers/ci-repo.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/boe/${n}`, import.meta.url), "utf8");
const registryText = readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8");
const registry = JSON.parse(registryText);
const entry = registry.sources.find((s) => s.id === "boe-lo-3-2018");
const parts = { meta: parseMetadata(fx("metadatos-BOE-A-2018-16673.json")), index: parseIndex(fx("indice-BOE-A-2018-16673.json")), block: parseBlock(fx("bloque-BOE-A-2018-16673-a5.xml")) };
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const lock = structuredClone(evaluateBoe({ entry, citation: { locator: { article: "5" }, quote: QUOTE }, ...parts, now: new Date("2026-10-21T12:00:00Z") }).lock);
const cite = (n = 1) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, quote: QUOTE, lock }));
const article = (meta = {}, n = 1) => `---\n${JSON.stringify({ slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "approved", approved_at: "2026-10-21", citations: cite(n), ...meta })}\n---\nTexto.`;

// Preload que sustituye a fetch: anota cada URL en un fichero y responde 503 (transitorio) o robots vacío.
const dir = mkdtempSync(join(tmpdir(), "lp-live-"));
const preload = join(dir, "fake-fetch.mjs");
writeFileSync(preload, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => { appendFileSync(process.env.FETCH_LOG, String(url) + "\\n"); return new Response("error", { status: 503 }); };\n`);
let seq = 0;
function run(files, { baseFiles = { "README.md": "m\n" }, env = {}, author = "martingrelu" } = {}) {
  const repo = makeRepo();
  const base = repo.commit(baseFiles, "base");
  repo.branch("pr");
  const head = repo.commit(files, "pr");
  const log = join(dir, `fetch-${++seq}.log`);
  const r = runTrusted("check-sources-live.mjs", { repo, base, head, author, branch: "feat/x", env: { NODE_OPTIONS: `--import=${preload}`, FETCH_LOG: log, LIVE_ATTEMPTS: "2", ...env } });
  const urls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  repo.cleanup();
  return { ...r, urls };
}

test("sin artículos aprobados, o con artículos fuera de alcance, no se sale a la red", () => {
  const draft = run({ "content/blog/tema.md": article({ review_status: "draft", approved_at: undefined }), "content/sources/registry.json": registryText });
  assert.equal(draft.status, 0, draft.stdout + draft.stderr);
  assert.deepEqual(draft.urls, []);
  // El artículo aprobado ya existía en la base y el PR solo toca otra cosa: fuera de alcance.
  const out = run({ "README.md": "cambio\n" }, { baseFiles: { "content/blog/tema.md": article(), "content/sources/registry.json": registryText } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.urls, []);
});

test("un artículo aprobado que el PR añade se comprueba en vivo, solo contra www.boe.es, con reintentos; el 503 persistente BLOQUEA", () => {
  const r = run({ "content/blog/tema.md": article(), "content/sources/registry.json": registryText });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNREACHABLE/);
  assert.match(r.stdout, /2 intentos/);
  assert.ok(r.urls.length >= 2, "se reintentó");
  assert.ok(r.urls.every((u) => new URL(u).hostname === "www.boe.es" && u.startsWith("https://")), r.urls.join("\n"));
  assert.deepEqual(outputProblems(r.stdout), []);
});

test("si el PR cambia una entrada del registro, los artículos que la citan entran en alcance aunque no se toquen", () => {
  const modified = JSON.parse(registryText);
  modified.sources.find((s) => s.id === "boe-lo-3-2018").title += " (modificada)";
  const r = run({ "content/sources/registry.json": JSON.stringify(modified) }, { baseFiles: { "content/blog/tema.md": article(), "content/sources/registry.json": registryText } });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.urls.length > 0, "se comprobó en vivo");
  assert.match(r.stdout, /fuentes nuevas o modificadas: 1/);
});

test("registro hostil con una URL de otro anfitrión: se rechaza ANTES de salir a la red", () => {
  const evil = JSON.parse(registryText);
  evil.sources.find((s) => s.id === "boe-lo-3-2018").urls.canonical = "https://atacante.example/boe";
  const r = run({ "content/blog/tema.md": article(), "content/sources/registry.json": JSON.stringify(evil) });
  assert.equal(r.status, 1);
  assert.deepEqual(r.urls, [], "ninguna petición");
});

test("modo y reintentos inválidos fallan cerrado; demasiadas citas falla en lugar de omitirse", () => {
  const files = { "content/blog/tema.md": article(), "content/sources/registry.json": registryText };
  for (const env of [{ LIVE_MODE: "lenient" }, { LIVE_MODE: "" }, { LIVE_ATTEMPTS: "0" }, { LIVE_ATTEMPTS: "9" }, { LIVE_ATTEMPTS: "abc" }, { LIVE_ATTEMPTS: "2.5" }]) {
    const r = run(files, { env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.deepEqual(r.urls, [], JSON.stringify(env));
  }
  const many = run({ "content/blog/tema.md": article({}, 41), "content/sources/registry.json": registryText });
  assert.equal(many.status, 1);
  assert.match(many.stdout, /demasiadas citas/);
  assert.deepEqual(many.urls, []);
});

test("modo informativo: no falla, pero lo no confirmado queda avisado como NO verificado y nunca como confirmado", () => {
  const r = run({ "content/blog/tema.md": article(), "content/sources/registry.json": registryText }, { env: { LIVE_MODE: "informative" } });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /NO verificado/);
  assert.doesNotMatch(r.stdout, /CONFIRMED/);
});

test("artículos tocados que no se pueden leer (enlace simbólico) o sin registro con aprobados: falla cerrado sin red", () => {
  const link = run({ "content/blog/tema.md": { symlink: "../../README.md" }, "content/sources/registry.json": registryText });
  assert.equal(link.status, 1);
  assert.deepEqual(link.urls, []);
  const noRegistry = run({ "content/blog/tema.md": article() });
  assert.equal(noRegistry.status, 1);
  assert.deepEqual(noRegistry.urls, []);
});

// Preload con las respuestas REALES recortadas del BOE. FAIL_FIRST=n hace que las n primeras peticiones devuelvan 503.
const okPreload = join(dir, "fake-boe.mjs");
const fixtureDir = new URL("./fixtures/boe/", import.meta.url).pathname;
writeFileSync(okPreload, `import { appendFileSync, readFileSync } from "node:fs";
let n = 0;
const fx = (name) => readFileSync(${JSON.stringify(fixtureDir)} + name, "utf8");
globalThis.fetch = async (url) => {
  appendFileSync(process.env.FETCH_LOG, String(url) + "\\n");
  if (++n <= Number(process.env.FAIL_FIRST ?? 0)) return new Response("error", { status: 503 });
  if (String(url).endsWith("/metadatos")) return new Response(fx("metadatos-BOE-A-2018-16673.json"), { status: 200 });
  if (String(url).endsWith("/texto/indice")) return new Response(fx("indice-BOE-A-2018-16673.json"), { status: 200 });
  if (String(url).endsWith("/texto/bloque/a5")) return new Response(fx("bloque-BOE-A-2018-16673-a5.xml"), { status: 200 });
  return new Response("", { status: 404 });
};\n`);

function runOk(env) {
  const repo = makeRepo();
  const base = repo.commit({ "README.md": "m\n" }, "base");
  repo.branch("pr");
  const head = repo.commit({ "content/blog/tema.md": article(), "content/sources/registry.json": registryText }, "pr");
  const log = join(dir, `ok-${++seq}.log`);
  const r = runTrusted("check-sources-live.mjs", { repo, base, head, author: "martingrelu", branch: "feat/x", env: { NODE_OPTIONS: `--import=${okPreload}`, FETCH_LOG: log, LIVE_ATTEMPTS: "3", ...env } });
  repo.cleanup();
  return r;
}

test("camino feliz: respuestas coherentes del BOE = exit 0 y la cita aparece como CONFIRMED", () => {
  const r = runOk({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CONFIRMED/);
  assert.match(r.stdout, /sources-live: CORRECTO/);
});

test("un 503 transitorio se supera con reintentos (exit 0, 2 intentos); si no se supera, exit 1", () => {
  const recovered = runOk({ FAIL_FIRST: "1" });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(recovered.stdout, /\[2 intentos\]|CONFIRMED/);
  const exhausted = runOk({ FAIL_FIRST: "99", LIVE_ATTEMPTS: "2" });
  assert.equal(exhausted.status, 1);
  assert.match(exhausted.stdout, /UNREACHABLE/);
  assert.doesNotMatch(exhausted.stdout, /sources-live: CORRECTO/);
});
