// Comprobación en vivo estricta con reintentos (seo-engine/sources/live-check.mjs). Sin red: clientes simulados con
// respuestas reales recortadas del BOE, la AEPD y el INSST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { createWebClient, verifyWebCitation } from "../seo-engine/sources/adapters/web.mjs";
import { DEFAULT_RETRY, MAX_ATTEMPTS, formatLiveItem, liveCheckArticle, liveCheckCitation, withRetries } from "../seo-engine/sources/live-check.mjs";

const boeFx = (n) => readFileSync(new URL(`./fixtures/boe/${n}`, import.meta.url), "utf8");
const webFx = (n) => readFileSync(new URL(`./fixtures/web/${n}`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8"));
const byId = (id) => registry.sources.find((s) => s.id === id);
const lopd = byId("boe-lo-3-2018");
const insst = byId("insst-gt-simplificacion-documental");
const aepd = byId("aepd-guia-calidad-datos-ia");
const NOW = new Date("2026-10-21T12:00:00Z");
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const parts = { meta: parseMetadata(boeFx("metadatos-BOE-A-2018-16673.json")), index: parseIndex(boeFx("indice-BOE-A-2018-16673.json")), block: parseBlock(boeFx("bloque-BOE-A-2018-16673-a5.xml")) };
const noSleep = async () => {};

// Cliente BOE simulado; `failures` fallos transitorios antes de responder bien (Infinity = siempre falla).
function boeClient({ failures = 0 } = {}) {
  const state = { calls: 0 };
  const gate = () => {
    state.calls++;
    if (state.calls <= failures) throw new Error("HTTP 503 al leer los metadatos");
  };
  return { state, metadata: async () => (gate(), parts.meta), index: async () => parts.index, block: async () => parts.block };
}
const boeLock = (patch = {}) => ({ ...structuredClone(evaluateBoe({ entry: lopd, citation: { locator: { article: "5" }, quote: QUOTE }, ...parts, now: NOW }).lock), ...patch });
const boeCite = (patch = {}, lockPatch = {}) => ({ id: "c1", source: lopd.id, type: "norma", locator: { article: "5" }, quote: QUOTE, lock: boeLock(lockPatch), ...patch });

const reply = (type, body, status = 200) => ({ status, headers: new Headers({ "content-type": type }), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
const routes = {
  "https://www.insst.es/robots.txt": reply("text/plain", webFx("robots-insst.txt")),
  "https://www.aepd.es/robots.txt": reply("text/plain", webFx("robots-aepd.txt")),
  [insst.urls.canonical]: reply("text/html; charset=UTF-8", webFx("insst-ficha-simplificacion.html")),
  [insst.urls.document]: reply("application/pdf", "%PDF-1.4 sintético"),
  [aepd.urls.canonical]: reply("application/pdf", "%PDF-1.4 sintético"),
  [aepd.urls.index]: reply("text/html; charset=UTF-8", webFx("aepd-listado-guias.html")),
};
// Cliente web con fallos transitorios (503) en las primeras `failures` peticiones a una URL canónica.
function webClient({ failures = 0, status = 503 } = {}) {
  const hits = {};
  const client = createWebClient({
    fetchImpl: async (url) => {
      if (!url.endsWith("robots.txt")) {
        hits[url] = (hits[url] ?? 0) + 1;
        if (hits[url] <= failures) return reply("text/html", "error", status);
      }
      return routes[url] ?? reply("text/plain", "", 404);
    },
    delayMs: 0,
    sleep: noSleep,
  });
  return { client, hits };
}
const webLock = async (entry) => structuredClone((await verifyWebCitation({ client: webClient().client, entry, citation: { locator: { section: "Resumen" } }, now: NOW })).lock);
const INSST_LOCK = await webLock(insst);
const webCite = (patch = {}) => ({ id: "g1", source: insst.id, type: "criterio", locator: { section: "Resumen" }, lock: structuredClone(INSST_LOCK), ...patch });
const retry = { attempts: 3, baseMs: 10, maxMs: 40, sleep: noSleep, random: () => 0.5 };

test("withRetries reintenta solo lo transitorio, con espera exponencial acotada y número máximo de intentos", async () => {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let n = 0;
  const flaky = await withRetries(async () => (++n < 3 ? { inconclusive: true } : { status: "verified" }), { attempts: 5, baseMs: 100, maxMs: 250, sleep, random: () => 1 });
  assert.deepEqual([flaky.attempts, flaky.result.status], [3, "verified"]);
  assert.deepEqual(waits, [100, 200], "esperas 100, 200 (con jitter máximo 1)");
  waits.length = 0;
  let calls = 0;
  const never = await withRetries(async () => (calls++, { inconclusive: true }), { attempts: 99, baseMs: 100, maxMs: 250, sleep, random: () => 1 });
  assert.equal(calls, MAX_ATTEMPTS, "99 se recorta al máximo");
  assert.equal(never.result.inconclusive, true);
  assert.ok(waits.every((ms) => ms <= 250), "ninguna espera supera el tope");
  assert.equal(waits.length, MAX_ATTEMPTS - 1);
  // Un resultado definitivo, aunque sea negativo, no se repite.
  calls = 0;
  await withRetries(async () => (calls++, { status: "failed", reasons: ["cita_no_encontrada"] }), { attempts: 5, sleep });
  assert.equal(calls, 1);
  // Valores absurdos de intentos caen al valor por defecto o al mínimo, nunca a "infinito" ni a cero.
  for (const attempts of [0, -3, NaN, 2.5, "3", Infinity]) {
    calls = 0;
    await withRetries(async () => (calls++, { inconclusive: true }), { attempts, sleep });
    assert.ok(calls >= 1 && calls <= MAX_ATTEMPTS, String(attempts));
  }
  assert.equal(DEFAULT_RETRY.attempts, 3);
});

test("BOE: cita coherente = confirmed; un fallo transitorio se supera con reintentos y se refleja el nº de intentos", async () => {
  const ok = await liveCheckCitation({ entry: lopd, citation: boeCite(), boe: boeClient(), now: NOW, retry });
  assert.deepEqual([ok.outcome, ok.attempts], ["confirmed", 1]);
  const client = boeClient({ failures: 2 });
  const recovered = await liveCheckCitation({ entry: lopd, citation: boeCite(), boe: client, now: NOW, retry });
  assert.deepEqual([recovered.outcome, recovered.attempts, client.state.calls], ["confirmed", 3, 3]);
});

test("BOE inconcluso tras los reintentos: unreachable, bloquea en estricto y NUNCA es excepcionable", async () => {
  const client = boeClient({ failures: Infinity });
  const result = await liveCheckArticle({ meta: { slug: "tema", review_status: "approved", citations: [boeCite()] } }, registry, { boe: client, now: NOW, retry, mode: "strict" });
  const [item] = result.items;
  assert.deepEqual([item.outcome, item.attempts, item.blocking, item.exceptionable], ["unreachable", 3, true, false]);
  assert.equal(result.blocking, true);
  assert.match(formatLiveItem(item), /^UNREACHABLE\s+c1 \(boe-lo-3-2018\) — fuente_inalcanzable \[3 intentos\]$/);
});

test("AEPD/INSST inconclusos: unreachable, bloquean en estricto y se marcan excepcionables (solo como dato para F2.3c)", async () => {
  const { client, hits } = webClient({ failures: 99 });
  const result = await liveCheckArticle({ meta: { slug: "tema", review_status: "approved", citations: [webCite()] } }, registry, { web: client, now: NOW, retry, mode: "strict" });
  const [item] = result.items;
  assert.deepEqual([item.outcome, item.blocking, item.exceptionable, item.attempts], ["unreachable", true, true, 3]);
  assert.equal(hits[insst.urls.canonical], 3);
  assert.match(formatLiveItem(item), /excepcionable con firma/);
});

test("web: fallo transitorio recuperado y cita coherente = confirmed (los motivos permanentes del candado no cuentan como cambio)", async () => {
  const { client } = webClient({ failures: 1 });
  const item = await liveCheckCitation({ entry: insst, citation: webCite(), web: client, now: NOW, retry });
  assert.deepEqual([item.outcome, item.attempts], ["confirmed", 2]);
});

test("cambios y contradicciones: la norma cambió tras el candado → changed; candado inconsistente o cita inventada → contradicted (sin reintentos)", async () => {
  const changed = await liveCheckCitation({ entry: lopd, citation: boeCite({}, { verified_at: "2000-01-01" }), boe: boeClient(), now: NOW, retry });
  assert.equal(changed.outcome, "changed");
  assert.match(changed.reasons.join(), /norma_modificada_tras_candado/);
  const forged = boeCite({}, { text_sha256: "0".repeat(64) });
  const bad = await liveCheckCitation({ entry: lopd, citation: forged, boe: boeClient(), now: NOW, retry });
  assert.deepEqual([bad.outcome, bad.attempts], ["contradicted", 1]);
  const invented = await liveCheckCitation({ entry: lopd, citation: boeCite({ quote: "esto no aparece en el artículo", lock: boeLock() }), boe: boeClient(), now: NOW, retry });
  assert.equal(invented.outcome, "contradicted");
  const webChanged = await liveCheckCitation({ entry: insst, citation: webCite({ lock: { ...INSST_LOCK, content_sha256: "f".repeat(64), text_sha256: "f".repeat(64) } }), web: webClient().client, now: NOW, retry });
  assert.deepEqual([webChanged.outcome, webChanged.reasons], ["changed", ["fuente_modificada"]]);
  const modifiedRegistry = await liveCheckCitation({ entry: { ...lopd, title: "otro título" }, citation: boeCite(), boe: boeClient(), now: NOW, retry });
  assert.equal(modifiedRegistry.outcome, "contradicted");
  assert.deepEqual(modifiedRegistry.reasons, ["registro_modificado"]);
});

test("citas que no se pueden comprobar (sin candado, fuente desconocida, forma inválida) son unchecked: bloquean y no llaman a la red", async () => {
  const boe = boeClient();
  const { lock, ...noLock } = boeCite();
  void lock;
  const cases = [
    [{ entry: lopd, citation: noLock }, "sin_candado"],
    [{ entry: undefined, citation: boeCite({ source: "boe-inventada" }) }, "fuente_desconocida"],
    [{ entry: lopd, citation: { id: "c1" } }, "cita_invalida"],
  ];
  for (const [args, reason] of cases) {
    const item = await liveCheckCitation({ ...args, boe, now: NOW, retry });
    assert.deepEqual([item.outcome, item.reasons, item.attempts], ["unchecked", [reason], 0]);
  }
  assert.equal(boe.state.calls, 0);
  const empty = await liveCheckArticle({ meta: { slug: "tema", review_status: "approved", citations: [] } }, registry, { boe, now: NOW, mode: "strict" });
  assert.equal(empty.blocking, true, "un artículo aprobado sin citas no se da por bueno");
});

test("un error inesperado del cliente nunca es éxito: unreachable (y el BOE no es excepcionable)", async () => {
  const exploding = { metadata: () => { throw new TypeError("boom"); } };
  const item = await liveCheckCitation({ entry: lopd, citation: boeCite(), boe: exploding, now: NOW, retry });
  assert.deepEqual([item.outcome, item.exceptionable], ["unreachable", false]);
  const crash = await liveCheckCitation({ entry: lopd, citation: boeCite(), boe: undefined, now: NOW, retry });
  assert.equal(crash.outcome, "unreachable");
});

test("modo informativo: no bloquea pero NUNCA convierte un resultado no confirmado en confirmed; modo inválido falla", async () => {
  const meta = { slug: "tema", review_status: "approved", citations: [boeCite()] };
  const informative = await liveCheckArticle({ meta }, registry, { boe: boeClient({ failures: Infinity }), now: NOW, retry, mode: "informative" });
  assert.equal(informative.blocking, false);
  assert.deepEqual(informative.items.map((i) => [i.outcome, i.blocking]), [["unreachable", false]]);
  await assert.rejects(liveCheckArticle({ meta }, registry, { boe: boeClient(), mode: "lenient" }), /modo inválido/);
  const strictByDefault = await liveCheckArticle({ meta }, registry, { boe: boeClient({ failures: Infinity }), now: NOW, retry });
  assert.equal(strictByDefault.mode, "strict");
  assert.equal(strictByDefault.blocking, true);
});

test("aepd: la guía solo-existencia con candado coherente se confirma sin leer el PDF", async () => {
  const lock = await webLock(aepd);
  const item = await liveCheckCitation({ entry: aepd, citation: { id: "a1", source: aepd.id, type: "criterio", locator: { section: "Resumen" }, lock }, web: webClient().client, now: NOW, retry });
  assert.equal(item.outcome, "confirmed");
});
