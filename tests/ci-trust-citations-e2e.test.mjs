// Extremo a extremo de `citations`: artículos aprobados con candado REAL (calculado sobre respuestas reales del BOE) dentro
// de un PR hostil. Comprueba que alterar la cita, el candado o el registro bloquea, y que lo coherente pasa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { makeRepo, outputProblems, runTrusted } from "./helpers/ci-repo.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/boe/${name}`, import.meta.url), "utf8");
const registryText = readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8");
const registry = JSON.parse(registryText);
const entry = registry.sources.find((s) => s.id === "boe-lo-3-2018");
const parts = { meta: parseMetadata(fixture("metadatos-BOE-A-2018-16673.json")), index: parseIndex(fixture("indice-BOE-A-2018-16673.json")), block: parseBlock(fixture("bloque-BOE-A-2018-16673-a5.xml")) };
const NOW = new Date("2026-10-21T12:00:00Z");
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const lock = (quote = QUOTE) => structuredClone(evaluateBoe({ entry, citation: { locator: { article: "5" }, quote }, ...parts, now: NOW }).lock);
const cite = (patch = {}) => ({ id: "c1", source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, quote: QUOTE, lock: lock(), ...patch });
const article = (meta = {}) => `---\n${JSON.stringify({ slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "approved", approved_at: "2026-10-21", citations: [cite()], ...meta })}\n---\nTexto sin referencias normativas.`;

function pr(changes) {
  const repo = makeRepo();
  const base = repo.commit({ "README.md": "m\n" });
  repo.branch("pr");
  const head = repo.commit(changes);
  return { repo, base, head };
}
const check = (s) => runTrusted("check-citations.mjs", { repo: s.repo, base: s.base, head: s.head, author: "martingrelu", branch: "feat/x" });

test("un artículo aprobado con cita y candado coherentes con el registro pasa", () => {
  const s = pr({ "content/blog/tema.md": article(), "content/sources/registry.json": registryText });
  const r = check(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /aprobados: 1/);
  s.repo.cleanup();
});

test("alteración de la cita, del candado o del registro: el control bloquea", () => {
  const tampered = { ...lock(), article_sha256: "0".repeat(64) };
  const reclassified = JSON.parse(registryText);
  reclassified.sources.find((s) => s.id === "boe-lo-3-2018").title += " (modificada)";
  const invalidRegistry = JSON.parse(registryText);
  invalidRegistry.sources.find((x) => x.id === "boe-lo-3-2018").binding = "no_vinculante";
  const s0 = pr({ "content/blog/tema.md": article(), "content/sources/registry.json": JSON.stringify(invalidRegistry) });
  const r0 = check(s0);
  assert.equal(r0.status, 1, "un registro reclasificado a un valor inválido falla cerrado");
  assert.match(r0.stdout, /registro de fuentes inválido/);
  s0.repo.cleanup();
  const cases = {
    "cita alterada tras el candado": { "content/blog/tema.md": article({ citations: [cite({ quote: `${QUOTE} y además se prohíbe todo` })] }) },
    "candado manipulado": { "content/blog/tema.md": article({ citations: [cite({ lock: tampered })] }) },
    "candado eliminado": { "content/blog/tema.md": article({ citations: [(({ lock: _l, ...rest }) => rest)(cite())] }) },
    "fuente inexistente": { "content/blog/tema.md": article({ citations: [cite({ source: "boe-inventada" })] }) },
    "artículo aprobado sin citas": { "content/blog/tema.md": article({ citations: [] }) },
    "registro modificado en el PR (válido por esquema)": { "content/blog/tema.md": article(), "content/sources/registry.json": JSON.stringify(reclassified) },
  };
  for (const [name, files] of Object.entries(cases)) {
    const s = pr({ "content/sources/registry.json": registryText, ...files });
    const r = check(s);
    assert.equal(r.status, 1, `${name}\n${r.stdout}`);
    assert.match(r.stdout, /bloquean la publicación/, name);
    if (name.startsWith("registro modificado")) assert.match(r.stdout, /registro_modificado/, name);
    assert.deepEqual(outputProblems(r.stdout), [], name);
    s.repo.cleanup();
  }
});

test("un error interno (registro ilegible) nunca se convierte en éxito", () => {
  const s = pr({ "content/blog/tema.md": article(), "content/sources/registry.json": "\u0000{" });
  const r = check(s);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falla cerrado/);
  s.repo.cleanup();
});
