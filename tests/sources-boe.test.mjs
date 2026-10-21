// Adaptador del BOE (seo-engine/sources/adapters/boe.mjs). Sin red: usa respuestas REALES de la API del BOE
// capturadas en tests/fixtures/boe/ (el índice está recortado a 10 bloques) y un fetch simulado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOE_API,
  compareWithLock,
  createBoeClient,
  evaluateBoe,
  parseBlock,
  parseIndex,
  parseMetadata,
  verifyBoeCitation,
  versionsAt,
} from "../seo-engine/sources/adapters/boe.mjs";
import { lockProblems } from "../seo-engine/sources/schema.mjs";
import { normalizeText, quoteMatches, sha256Hex } from "../seo-engine/sources/text.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/boe/${name}`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8"));
const entryFor = (id) => structuredClone(registry.sources.find((entry) => entry.id === id));
const NOW = new Date("2026-10-21T12:00:00Z");

const meta = parseMetadata(fixture("metadatos-BOE-A-2018-16673.json"));
const index = parseIndex(fixture("indice-BOE-A-2018-16673.json"));
const a5 = parseBlock(fixture("bloque-BOE-A-2018-16673-a5.xml"));
const a34 = parseBlock(fixture("bloque-BOE-A-2015-11430-a34.xml"));
const lopdgdd = entryFor("boe-lo-3-2018");
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const cita = (extra = {}) => ({ id: "c1", source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, quote: QUOTE, ...extra });
const evaluate = (overrides = {}) => evaluateBoe({ entry: lopdgdd, citation: cita(), meta, index, block: a5, now: NOW, ...overrides });

// Datos del Estatuto de los Trabajadores art. 34 (4 versiones reales); el índice y los metadatos son sintéticos
// y derivan de los reales de la LOPDGDD cambiando solo identificador y número.
const etEntry = entryFor("boe-rdl-2-2015");
const etMeta = { ...meta, boeId: "BOE-A-2015-11430", numeroOficial: "2/2015" };
const etIndex = new Map([["a34", { titulo: "Artículo 34", fechaActualizacion: "20230630" }]]);
const etCita = (extra = {}) => ({ id: "c1", source: "boe-rdl-2-2015", type: "norma", locator: { article: "34" }, ...extra });
const etEvaluate = (citation, now = NOW) => evaluateBoe({ entry: etEntry, citation, meta: etMeta, index: etIndex, block: a34, now });

// ---- Análisis de las respuestas reales ----------------------------------------------------
test("parseMetadata normaliza los metadatos reales: vigencia, derogación, consolidación y ELI", () => {
  assert.equal(meta.boeId, "BOE-A-2018-16673");
  assert.equal(meta.numeroOficial, "3/2018");
  assert.match(meta.title, /^Ley Orgánica 3\/2018, de 5 de diciembre/);
  assert.deepEqual([meta.derogada, meta.anulada, meta.vigenciaAgotada, meta.consolidacion], ["N", "N", "N", "3"]);
  assert.equal(meta.urlEli, "https://www.boe.es/eli/es/lo/2018/12/05/3");
  assert.match(meta.fechaActualizacion, /^\d{8}T\d{6}Z$/);
});

test("parseMetadata e parseIndex rechazan respuestas que no son las esperadas", () => {
  assert.throws(() => parseMetadata("<xml/>"), /no es JSON/);
  assert.throws(() => parseMetadata(JSON.stringify({ data: [{ identificador: "x" }] })), /respuesta inesperada/);
  assert.throws(() => parseMetadata(fixture("respuesta-404.xml")), /no es JSON/);
  assert.throws(() => parseIndex("no json"), /no es JSON/);
  assert.throws(() => parseIndex(JSON.stringify({ data: [{}] })), /respuesta inesperada/);
});

test("parseIndex devuelve los bloques con su fecha de actualización", () => {
  assert.equal(index.size, 10);
  assert.ok(index.has("a5") && index.has("pr") && index.has("ti"));
  assert.match(index.get("a5").fechaActualizacion, /^\d{8}$/);
  assert.equal(index.get("a5").titulo, "Artículo 5");
});

test("parseBlock lee el artículo real con su versión y su texto", () => {
  assert.deepEqual([a5.id, a5.titulo, a5.tipo, a5.versions.length], ["a5", "Artículo 5", "precepto", 1]);
  assert.equal(a5.versions[0].fechaVigencia, "20181207");
  assert.match(a5.versions[0].text, /^Artículo 5\. Deber de confidencialidad\./);
  assert.ok(quoteMatches(a5.versions[0].text, QUOTE).ok);
});

test("parseBlock lee un artículo con varias versiones reales (art. 34 del Estatuto de los Trabajadores)", () => {
  assert.deepEqual(a34.versions.map((version) => version.fechaVigencia), ["20151113", "20190308", "20190313", "20230630"]);
  assert.ok(a34.versions.every((version) => version.text.startsWith("Artículo 34. Jornada.")));
  assert.ok(!/&amp;|&lt;|<p/.test(a34.versions.at(-1).text), "sin entidades ni etiquetas");
});

test("parseBlock rechaza errores del BOE y respuestas sin versiones", () => {
  assert.throws(() => parseBlock(fixture("respuesta-404.xml")), /no es un 200/);
  assert.throws(() => parseBlock("<response><status><code>200</code></status></response>"), /sin <bloque>/);
  assert.throws(() => parseBlock('<response><status><code>200</code></status><data><texto><bloque id="a1" tipo="precepto" titulo="A"></bloque></texto></data></response>'), /ausentes/);
  assert.throws(
    () => parseBlock('<response><status><code>200</code></status><bloque id="a1" tipo="x" titulo="A"><version fecha_publicacion="20200101" fecha_vigencia="sin"><p>t</p></version></bloque></response>'),
    /sin fecha de vigencia/
  );
});

test("versionsAt elige la versión en vigor a una fecha y separa anteriores y futuras", () => {
  const at = (date) => versionsAt(a34, date);
  assert.equal(at("20260101").current.fechaVigencia, "20230630");
  assert.equal(at("20260101").earlier.length, 3);
  assert.equal(at("20260101").future.length, 0);
  assert.equal(at("20190310").current.fechaVigencia, "20190308");
  assert.deepEqual(at("20190310").future.map((v) => v.fechaVigencia), ["20190313", "20230630"]);
  assert.equal(at("20151001").current, null, "antes de la primera vigencia no hay versión en vigor");
});

// ---- Evaluación de citas ------------------------------------------------------------------
test("una cita literal en la versión vigente es verified y genera un candado completo y válido", () => {
  const result = evaluate();
  assert.equal(result.status, "verified");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(lockProblems(result.lock), []);
  assert.deepEqual(
    { ...result.lock, text_sha256: "x", quote_sha256: "x" },
    {
      verified_at: "2026-10-21",
      engine: "boe-api-v1",
      boe_id: "BOE-A-2018-16673",
      block_id: "a5",
      block_fecha_actualizacion: index.get("a5").fechaActualizacion,
      norma_fecha_actualizacion: meta.fechaActualizacion,
      version_fecha_vigencia: "20181207",
      text_sha256: "x",
      quote_sha256: "x",
      status: "verified",
      reasons: [],
    }
  );
  assert.equal(result.lock.text_sha256, sha256Hex(normalizeText(a5.versions[0].text)));
  assert.equal(result.lock.quote_sha256, sha256Hex(normalizeText(QUOTE)));
});

test("la cita tolera diferencias tipográficas y omisiones, pero no cambia palabras", () => {
  assert.equal(evaluate({ citation: cita({ quote: "estarán  sujetas al deber de confidencialidad […] (UE) 2016/679" }) }).status, "verified");
  const failed = evaluate({ citation: cita({ quote: "estarán sujetas al deber de reserva al que se refiere el artículo 5.1.f)" }) });
  assert.deepEqual([failed.status, failed.reasons, failed.lock], ["failed", ["cita_no_encontrada"], undefined]);
});

test("sin cita textual solo se comprueba la existencia: needs_review, nunca verified", () => {
  const result = evaluate({ citation: cita({ quote: undefined }) });
  assert.deepEqual([result.status, result.reasons, result.lock.status, result.lock.quote_sha256], ["needs_review", ["solo_existencia"], "needs_review", null]);
  assert.deepEqual(lockProblems(result.lock), []);
});

test("una norma derogada, anulada o con vigencia agotada falla y no genera candado", () => {
  for (const [patch, reason] of [[{ derogada: "S" }, "norma_derogada"], [{ anulada: "S" }, "norma_anulada"], [{ vigenciaAgotada: "S" }, "vigencia_agotada"], [{ derogada: "P" }, "norma_derogada"]]) {
    const result = evaluate({ meta: { ...meta, ...patch } });
    assert.equal(result.status, "failed", reason);
    assert.ok(result.reasons.includes(reason), reason);
    assert.equal(result.lock, undefined);
  }
});

test("una consolidación no finalizada exige revisión", () => {
  const result = evaluate({ meta: { ...meta, consolidacion: "2" } });
  assert.deepEqual([result.status, result.reasons], ["needs_review", ["consolidacion_no_finalizada"]]);
});

test("el registro debe coincidir con la fuente: otro identificador u otro número falla", () => {
  assert.deepEqual(evaluate({ entry: { ...lopdgdd, official_ref: { ...lopdgdd.official_ref, boe_id: "BOE-A-1995-24292" } } }).reasons, ["registro_no_coincide"]);
  assert.deepEqual(evaluate({ entry: { ...lopdgdd, official_ref: { ...lopdgdd.official_ref, numero_oficial: "4/2018" } } }).reasons, ["registro_no_coincide"]);
});

test("un artículo inexistente falla (por el índice o por falta de bloque)", () => {
  const missing = evaluate({ citation: cita({ locator: { article: "999" } }), block: null });
  assert.deepEqual([missing.status, missing.reasons], ["failed", ["locator_no_encontrado"]]);
  assert.deepEqual(evaluate({ block: null }).reasons, ["locator_no_encontrado"]);
});

test("una cita que solo estaba en una versión anterior se distingue de una inventada", () => {
  const norm = a34.versions.map((version) => normalizeText(version.text));
  const onlyOld = norm[0].split(/(?<=\.)\s+/).find((sentence) => sentence.length >= 40 && !norm.at(-1).includes(sentence));
  assert.ok(onlyOld, "el fixture debe tener una frase que solo está en la versión de 2015");
  const old = etEvaluate(etCita({ quote: onlyOld }));
  assert.deepEqual([old.status, old.reasons], ["failed", ["cita_solo_en_version_anterior"]]);
  const invented = etEvaluate(etCita({ quote: "Esta frase no existe en ninguna versión del artículo treinta y cuatro." }));
  assert.deepEqual(invented.reasons, ["cita_no_encontrada"]);
  const current = etEvaluate(etCita({ quote: "La duración de la jornada de trabajo será la pactada en los convenios colectivos" }));
  assert.deepEqual([current.status, current.lock.version_fecha_vigencia], ["verified", "20230630"]);
});

test("una versión con vigencia futura exige revisión y el candado recoge la versión vigente hoy", () => {
  const result = etEvaluate(etCita({ quote: "La duración de la jornada de trabajo será la pactada en los convenios colectivos" }), new Date("2023-01-01T00:00:00Z"));
  assert.deepEqual([result.status, result.reasons, result.lock.version_fecha_vigencia], ["needs_review", ["version_con_vigencia_futura"], "20190313"]);
  const none = etEvaluate(etCita(), new Date("2015-10-01T00:00:00Z"));
  assert.deepEqual([none.status, none.reasons], ["failed", ["sin_version_vigente"]]);
});

// ---- Comparación con el candado (autentica los candados) --------------------------------------
test("compareWithLock: sin cambios verifica; cambios reales exigen revisión; candados imposibles fallan", () => {
  const live = evaluate();
  assert.deepEqual([compareWithLock(live, live.lock).status, compareWithLock(live, live.lock).reasons], ["verified", []]);
  // Fuente modificada tras el candado (el bloque se actualizó el 2018-12-06, después de un candado de enero de 2018).
  const changed = compareWithLock(live, { ...live.lock, verified_at: "2018-01-01", text_sha256: "c".repeat(64) });
  assert.deepEqual([changed.status, changed.reasons], ["needs_review", ["fuente_modificada"]]);
  // Mismo texto pero el bloque se actualizó después del candado.
  const touched = compareWithLock(live, { ...live.lock, verified_at: "2018-01-01" });
  assert.deepEqual([touched.status, touched.reasons], ["needs_review", ["norma_modificada_tras_candado"]]);
  // Texto distinto sin que la fuente haya cambiado desde la fecha del candado: candado forjado o erróneo.
  const forged = compareWithLock(live, { ...live.lock, verified_at: "2026-10-01", text_sha256: "c".repeat(64) });
  assert.deepEqual([forged.status, forged.reasons], ["failed", ["candado_inconsistente"]]);
  // Un fallo en vivo se mantiene.
  assert.equal(compareWithLock(evaluate({ meta: { ...meta, derogada: "S" } }), live.lock).status, "failed");
});

// ---- Cliente HTTP -----------------------------------------------------------------------------
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[url.replace(`${BOE_API}/`, "")];
    if (route instanceof Error) throw route;
    const { status = 200, body = "" } = route ?? { status: 404, body: fixture("respuesta-404.xml") };
    return { status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}
const realRoutes = () => ({
  "BOE-A-2018-16673/metadatos": { body: fixture("metadatos-BOE-A-2018-16673.json") },
  "BOE-A-2018-16673/texto/indice": { body: fixture("indice-BOE-A-2018-16673.json") },
  "BOE-A-2018-16673/texto/bloque/a5": { body: fixture("bloque-BOE-A-2018-16673-a5.xml") },
});
const clientFor = (routes, options = {}) => {
  const fetchImpl = fakeFetch(routes);
  return { fetchImpl, client: createBoeClient({ fetchImpl, delayMs: 0, sleep: async () => {}, ...options }) };
};

test("el cliente pide JSON o XML según el endpoint, se identifica y cachea las respuestas", async () => {
  const { client, fetchImpl } = clientFor(realRoutes());
  assert.equal((await client.metadata("BOE-A-2018-16673")).numeroOficial, "3/2018");
  await client.metadata("BOE-A-2018-16673");
  assert.equal((await client.index("BOE-A-2018-16673")).size, 10);
  assert.equal((await client.block("BOE-A-2018-16673", "a5")).id, "a5");
  assert.equal(fetchImpl.calls.length, 3, "la segunda petición de metadatos sale de la caché");
  assert.deepEqual(fetchImpl.calls.map((call) => call.init.headers.Accept), ["application/json", "application/json", "application/xml"]);
  assert.ok(fetchImpl.calls.every((call) => /LegalPreventSourceCheck/.test(call.init.headers["User-Agent"])));
  assert.ok(fetchImpl.calls.every((call) => call.url.startsWith(`${BOE_API}/BOE-A-2018-16673/`) && !call.init.method), "solo GET a la API oficial");
});

test("el cliente limita el ritmo, valida los identificadores y no cachea los errores", async () => {
  const waits = [];
  const { client, fetchImpl } = clientFor(realRoutes(), { delayMs: 500, sleep: async (ms) => waits.push(ms) });
  await client.metadata("BOE-A-2018-16673");
  await client.index("BOE-A-2018-16673");
  assert.ok(waits.length >= 1 && waits.every((ms) => ms > 0 && ms <= 500), "espera entre peticiones distintas");
  await assert.rejects(client.metadata("../../etc/passwd"), /identificador BOE inválido/);
  await assert.rejects(client.metadata("BOE-A-2018-16673?x=1"), /identificador BOE inválido/);
  await assert.rejects(client.block("BOE-A-2018-16673", "../a5"), /bloque inválido/);
  assert.equal(fetchImpl.calls.length, 2, "los identificadores inválidos no llegan a la red");
  const flaky = clientFor({ "BOE-A-2018-16673/metadatos": { status: 503, body: "" } });
  await assert.rejects(flaky.client.metadata("BOE-A-2018-16673"), /HTTP 503/);
  await assert.rejects(flaky.client.metadata("BOE-A-2018-16673"), /HTTP 503/);
  assert.equal(flaky.fetchImpl.calls.length, 2, "un 503 no se cachea");
  assert.equal(await clientFor({}).client.metadata("BOE-A-2099-99999"), null, "404 = no existe");
});

// ---- Verificación en línea -----------------------------------------------------------------------
test("verifyBoeCitation con datos reales: verified, y un identificador inventado falla", async () => {
  const { client } = clientFor(realRoutes());
  const ok = await verifyBoeCitation({ client, entry: lopdgdd, citation: cita(), now: NOW });
  assert.deepEqual([ok.status, ok.lock.block_id], ["verified", "a5"]);
  const ghost = { ...lopdgdd, official_ref: { ...lopdgdd.official_ref, boe_id: "BOE-A-2099-99999" } };
  const missing = await verifyBoeCitation({ client: clientFor({}).client, entry: ghost, citation: cita(), now: NOW });
  assert.deepEqual([missing.status, missing.reasons], ["failed", ["identificador_inexistente"]]);
});

test("un artículo que no está en el índice falla sin pedir el bloque", async () => {
  const { client, fetchImpl } = clientFor(realRoutes());
  const result = await verifyBoeCitation({ client, entry: lopdgdd, citation: cita({ locator: { article: "999" } }), now: NOW });
  assert.deepEqual([result.status, result.reasons], ["failed", ["locator_no_encontrado"]]);
  assert.ok(!fetchImpl.calls.some((call) => call.url.includes("/texto/bloque/")));
});

test("los errores de red, 5xx, tiempo agotado o formato inesperado son inconclusos: nunca verified", async () => {
  const cases = {
    "error de red": { "BOE-A-2018-16673/metadatos": new Error("ECONNRESET") },
    "HTTP 500": { "BOE-A-2018-16673/metadatos": { status: 500 } },
    "HTTP 503": { ...realRoutes(), "BOE-A-2018-16673/texto/indice": { status: 503 } },
    "JSON roto": { ...realRoutes(), "BOE-A-2018-16673/metadatos": { body: "{no es json" } },
    "XML sin versiones": { ...realRoutes(), "BOE-A-2018-16673/texto/bloque/a5": { body: "<response><status><code>200</code></status></response>" } },
    "bloque con error": { ...realRoutes(), "BOE-A-2018-16673/texto/bloque/a5": { body: fixture("respuesta-404.xml") } },
  };
  for (const [label, routes] of Object.entries(cases)) {
    const result = await verifyBoeCitation({ client: clientFor(routes).client, entry: lopdgdd, citation: cita(), now: NOW });
    assert.deepEqual([result.status, result.reasons, result.inconclusive], ["needs_review", ["fuente_inalcanzable"], true], label);
    assert.equal(result.lock, undefined, label);
  }
  const hang = createBoeClient({ delayMs: 0, timeoutMs: 20, sleep: async () => {}, fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("tiempo agotado")))) });
  const timedOut = await verifyBoeCitation({ client: hang, entry: lopdgdd, citation: cita(), now: NOW });
  assert.deepEqual([timedOut.status, timedOut.inconclusive], ["needs_review", true]);
});
