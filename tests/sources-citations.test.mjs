// Verificación offline de las citas de un artículo (seo-engine/sources/verify-citations.mjs). Sin red.
// Garantía central: una cita inventada, no verificada o dudosa NUNCA se considera válida automáticamente.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { contentHash } from "../seo-engine/blog-render.mjs";
import { formatItem, verifyArticleCitations } from "../seo-engine/sources/verify-citations.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/boe/${name}`, import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const registry = JSON.parse(readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8"));
const guide = {
  id: "aepd-guia-ejemplo",
  authority: "AEPD",
  kind: "guia",
  binding: "no_vinculante",
  title: "Guía de ejemplo de la AEPD",
  official_ref: { reference: "Guía de ejemplo" },
  urls: { canonical: "https://www.aepd.es/guias/ejemplo.pdf" },
  added_at: "2026-10-01",
};
const withGuide = { version: 1, sources: [...registry.sources, guide] };
const NOW = new Date("2026-10-21T12:00:00Z");
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const parts = { meta: parseMetadata(fixture("metadatos-BOE-A-2018-16673.json")), index: parseIndex(fixture("indice-BOE-A-2018-16673.json")), block: parseBlock(fixture("bloque-BOE-A-2018-16673-a5.xml")) };
const lopdgdd = registry.sources.find((entry) => entry.id === "boe-lo-3-2018");

// Candado REAL: lo calcula el adaptador sobre las respuestas reales del BOE.
const lockFor = (quote) => structuredClone(evaluateBoe({ entry: lopdgdd, citation: { locator: { article: "5" }, quote }, ...parts, now: NOW }).lock);
const citation = (patch = {}) => ({ id: "c1", source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, quote: QUOTE, lock: lockFor(QUOTE), ...patch });
const article = (meta = {}, body = "Texto del artículo sin referencias normativas.") => ({
  meta: { slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "approved", approved_at: "2026-10-21", citations: [citation()], ...meta },
  body,
});
const run = (art, options = {}, reg = registry) => verifyArticleCitations(art, reg, { now: NOW, ...options });
const find = (result, id = "c1") => result.items.find((item) => item.citation === id);
const withoutLock = () => {
  const { lock, ...rest } = citation();
  void lock;
  return rest;
};

test("una cita literal con candado coherente es verified, pero no sustituye a la firma humana", () => {
  const result = run(article());
  assert.equal(result.blocking, false);
  assert.deepEqual([find(result).status, find(result).failed, find(result).pending], ["verified", [], []]);
  assert.match(formatItem(find(result)), /^VERIFIED\s+c1 \(boe-lo-3-2018\)$/);
});

test("sin candado la cita falla; en un borrador se informa pero no bloquea", () => {
  const approved = run(article({ citations: [withoutLock()] }));
  assert.deepEqual([find(approved).status, find(approved).failed, approved.blocking], ["failed", ["sin_candado"], true]);
  const draft = run(article({ citations: [withoutLock()], review_status: "in_review", approved_at: undefined }));
  assert.deepEqual([find(draft).status, draft.blocking, draft.approved], ["failed", false, false]);
});

test("una fuente que no está en el registro es una cita inventada: falla", () => {
  const result = run(article({ citations: [citation({ source: "boe-ley-inventada" })] }));
  assert.deepEqual([find(result).failed, result.blocking], [["fuente_desconocida"], true]);
});

test("una guía no vinculante no puede apoyar una afirmación sobre una norma", () => {
  const asNorm = run(article({ citations: [{ id: "g1", source: "aepd-guia-ejemplo", type: "norma", locator: { block: "a1" } }] }), {}, withGuide);
  assert.ok(find(asNorm, "g1").failed.includes("guia_como_norma"));
  assert.equal(asNorm.blocking, true);
  const asCriterion = run(article({ citations: [{ id: "g1", source: "aepd-guia-ejemplo", type: "criterio", locator: { block: "a1" } }] }), {}, withGuide);
  assert.deepEqual([find(asCriterion, "g1").status, find(asCriterion, "g1").pending], ["needs_review", ["adaptador_no_implementado"]]);
  assert.equal(asCriterion.blocking, true, "AEPD e INSST aún no se verifican (F2.2): necesitan reconocimiento humano");
  const acknowledged = run(
    article({ citations: [{ id: "g1", source: "aepd-guia-ejemplo", type: "criterio", locator: { block: "a1" } }], review_ack: [{ citation: "g1", reason: "adaptador_no_implementado", note: "Guía revisada a mano en la web de la AEPD." }] }),
    {},
    withGuide
  );
  assert.deepEqual([find(acknowledged, "g1").acknowledged, acknowledged.blocking], [["adaptador_no_implementado"], false]);
});

test("editar la cita después del candado, o añadirla o quitarla, invalida el candado", () => {
  for (const patch of [{ quote: "estarán sujetas al deber de reserva profesional del tratamiento" }, { quote: undefined }]) {
    const result = run(article({ citations: [citation(patch)] }));
    assert.deepEqual(find(result).failed, ["cita_editada_tras_candado"], JSON.stringify(patch).slice(0, 40));
  }
  const noQuoteLock = lockFor(undefined);
  const added = run(article({ citations: [citation({ lock: noQuoteLock })] }));
  assert.deepEqual(find(added).failed, ["cita_editada_tras_candado"]);
});

test("un candado de otra norma, de otro artículo o mal formado es inconsistente", () => {
  const bad = (patch) => run(article({ citations: [citation({ lock: { ...lockFor(QUOTE), ...patch } })] }));
  assert.deepEqual(find(bad({ boe_id: "BOE-A-1995-24292" })).failed, ["candado_inconsistente"]);
  assert.deepEqual(find(bad({ block_id: "a6" })).failed, ["candado_inconsistente"]);
  // Un candado con formato inválido se rechaza ya como cita inválida (falla igualmente y bloquea).
  for (const patch of [{ text_sha256: "abc" }, { status: "failed" }, { engine: "otro" }, { verified_at: "2026-02-31" }, { extra: 1 }]) {
    assert.deepEqual([find(bad(patch)).failed, bad(patch).blocking], [["cita_invalida"], true], JSON.stringify(patch));
  }
  assert.deepEqual(find(bad({ verified_at: "2026-10-22" })).failed, ["candado_futuro"]);
});

test("un candado antiguo caduca y exige revisión explícita", () => {
  const stale = citation({ lock: { ...lockFor(QUOTE), verified_at: "2026-09-01" } });
  const result = run(article({ citations: [stale] }));
  assert.deepEqual([find(result).status, find(result).pending, result.blocking], ["needs_review", ["candado_caducado"], true]);
  assert.equal(run(article({ citations: [stale] }), { maxLockAgeDays: 90 }).blocking, false, "el plazo es configurable");
  const ack = [{ citation: "c1", reason: "candado_caducado", note: "Vuelto a comprobar a mano en el BOE el mismo día." }];
  assert.equal(run(article({ citations: [stale], review_ack: ack })).blocking, false);
});

test("un candado con motivos de revisión bloquea hasta que se reconoce por escrito y con la nota adecuada", () => {
  const noQuote = citation({ quote: undefined, lock: lockFor(undefined) });
  const pending = run(article({ citations: [noQuote] }));
  assert.deepEqual([find(pending).status, find(pending).pending, pending.blocking], ["needs_review", ["solo_existencia"], true]);
  const ack = { citation: "c1", reason: "solo_existencia", note: "Afirmación genérica; se ha leído el artículo completo." };
  assert.equal(run(article({ citations: [noQuote], review_ack: [ack] })).blocking, false);
  assert.match(formatItem(find(run(article({ citations: [noQuote], review_ack: [ack] })))), /✓reconocido:solo_existencia/);
  // Reconocer un motivo que no es el pendiente no sirve y además es un reconocimiento sin uso.
  const wrong = run(article({ citations: [noQuote], review_ack: [{ ...ack, reason: "candado_caducado" }] }));
  assert.equal(wrong.blocking, true);
  assert.deepEqual(find(wrong).pending, ["solo_existencia"]);
  assert.deepEqual(wrong.items.at(-1).failed, ["ack_sin_uso"]);
});

test("un reconocimiento sin uso falla: no puede quedar como cheque en blanco", () => {
  const result = run(article({ review_ack: [{ citation: "c1", reason: "solo_existencia", note: "Reconocimiento que no corresponde a nada." }] }));
  assert.deepEqual([result.items.at(-1).citation, result.items.at(-1).failed, result.blocking], ["c1", ["ack_sin_uso"], true]);
  const failedCannotBeAcked = run(article({ citations: [withoutLock()], review_ack: [{ citation: "c1", reason: "sin_candado", note: "Intento de reconocer un fallo." }] }));
  assert.equal(failedCannotBeAcked.blocking, true, "un fallo no es reconocible");
  assert.match(failedCannotBeAcked.items.map((i) => i.failed.join()).join(), /ack_sin_uso|cita_invalida/);
});

test("un artículo aprobado sin ninguna cita exige reconocimiento; un borrador no", () => {
  const empty = run(article({ citations: [] }));
  assert.deepEqual([empty.items[0].citation, empty.items[0].pending, empty.blocking], ["(artículo)", ["articulo_sin_citas"], true]);
  const ack = run(article({ citations: [], review_ack: [{ citation: "(artículo)", reason: "articulo_sin_citas", note: "Contenido divulgativo sin afirmaciones normativas." }] }));
  assert.equal(ack.blocking, false);
  const draft = run(article({ citations: undefined, review_status: "draft", approved_at: undefined }));
  assert.deepEqual([draft.items.length, draft.blocking], [0, false]);
});

test("las normas mencionadas en el cuerpo sin cita registrada se marcan para revisión", () => {
  assert.equal(run(article({}, "Según la Ley Orgánica 3/2018 y BOE-A-2018-16673, el deber de confidencialidad persiste.")).blocking, false);
  const uncited = run(article({}, "Además de la Ley 31/1995 y el Real Decreto 39/1997, aplica la LOPDGDD."));
  assert.deepEqual([find(uncited, "(cuerpo)").pending, uncited.blocking], [["referencia_sin_cita"], true]);
  const ack = [{ citation: "(cuerpo)", reason: "referencia_sin_cita", note: "Menciones históricas sin afirmación normativa." }];
  assert.equal(run(article({ review_ack: ack }, "Además de la Ley 31/1995 aplica la LOPDGDD.")).blocking, false);
  assert.equal(run(article({}, "Solo se menciona el artículo 5 y el Reglamento (UE) 2016/679.")).blocking, false, "limitación documentada: la heurística no cubre normas de la UE");
});

test("las citas mal formadas, duplicadas o con reconocimientos inválidos fallan", () => {
  assert.deepEqual(find(run(article({ citations: [{ ...citation(), verified: true }] })).items[0].citation && run(article({ citations: [{ ...citation(), verified: true }] })), "c1").failed, ["cita_invalida"]);
  const duplicated = run(article({ citations: [citation(), citation()] }));
  assert.equal(duplicated.items.filter((item) => item.failed.includes("cita_invalida")).length, 1);
  assert.equal(run(article({ citations: [citation({ type: "opinion" })] })).blocking, true);
  assert.equal(run(article({ review_ack: [{ citation: "c1", reason: "solo_existencia", note: "corta" }] })).blocking, true);
  assert.equal(run(article({ citations: "no es una lista" })).blocking, true);
});

test("las citas, los candados y los reconocimientos forman parte del contenido que se firma", () => {
  const base = article();
  const hash = contentHash(base.meta, base.body);
  assert.notEqual(contentHash({ ...base.meta, citations: [citation({ quote: QUOTE + " modificada" })] }, base.body), hash);
  assert.notEqual(contentHash({ ...base.meta, citations: [citation({ lock: { ...lockFor(QUOTE), verified_at: "2026-10-20" } })] }, base.body), hash);
  assert.notEqual(contentHash({ ...base.meta, review_ack: [{ citation: "c1", reason: "solo_existencia", note: "Una nota de reconocimiento." }] }, base.body), hash);
  assert.equal(contentHash({ ...base.meta, approved_at: "2026-10-22" }, base.body), hash, "los campos de aprobación no cuentan");
});

// ---- CLI ------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "lp-sources-"));
after(() => rmSync(work, { recursive: true, force: true }));
function project(name, { articles = [], withRegistry = true } = {}) {
  const dir = join(work, name);
  mkdirSync(join(dir, "content"), { recursive: true });
  if (withRegistry) writeFileSync(join(dir, "registry.json"), JSON.stringify(withGuide));
  for (const { meta, body } of articles) writeFileSync(join(dir, "content", `${meta.slug}.md`), `---\n${JSON.stringify(meta)}\n---\n${body}`);
  return dir;
}
const cli = (dir, args = []) =>
  spawnSync("node", ["seo-engine/sources/verify-citations.mjs", "--registry", join(dir, "registry.json"), "--content", join(dir, "content"), ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });

test("la CLI offline devuelve 0 si todo es coherente y 1 si algo bloquea", () => {
  const good = cli(project("cli-ok", { articles: [article()] }));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /ok\s+tema/);
  const blocked = cli(project("cli-blocked", { articles: [article({ citations: [] })] }));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /BLOQUEA tema/);
  assert.match(blocked.stdout, /articulo_sin_citas/);
  const draftOnly = cli(project("cli-draft", { articles: [article({ citations: [withoutLock()], review_status: "draft", approved_at: undefined })] }));
  assert.equal(draftOnly.status, 0);
  assert.match(draftOnly.stdout, /borrador: informativo/);
  assert.match(draftOnly.stdout, /sin_candado/);
});

test("sin registro de fuentes la CLI falla en cuanto hay artículos aprobados o con citas", () => {
  const missing = cli(project("cli-noreg", { articles: [article()], withRegistry: false }));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /falta el registro de fuentes/);
  const empty = cli(project("cli-empty", { articles: [], withRegistry: false }));
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /nada que verificar/);
});

test("un registro inválido o con una fuente falsa hace fallar la CLI", () => {
  const dir = project("cli-badreg", { articles: [article()] });
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 1, sources: [{ ...registry.sources[0], urls: { canonical: "https://example.com/ley" } }] }));
  const result = cli(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /registro de fuentes inválido/);
  assert.match(result.stderr, /urls.canonical/);
});

test("la CLI en línea exige un modo y no escribe nada por defecto", () => {
  const noMode = spawnSync("node", ["seo-engine/sources/verify-sources.mjs"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(noMode.status, 1);
  assert.match(noMode.stderr, /uso: verify-sources\.mjs/);
  const noSlug = spawnSync("node", ["seo-engine/sources/verify-sources.mjs", "--lock"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(noSlug.status, 1);
  assert.match(noSlug.stderr, /--lock necesita el slug/);
});
