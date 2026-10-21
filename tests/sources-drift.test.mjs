// Comprobación programada de deriva (seo-engine/sources/drift.mjs): estados, precedencia y códigos de salida.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_CITATIONS, STATES, driftCheck } from "../seo-engine/sources/drift.mjs";
import { aepd, changedClient, fixtureClient, insst, registry, scenario, webCitation } from "./helpers/exceptions-fixture.mjs";

const NOW = new Date("2026-10-21T12:00:00Z");
const retry = { attempts: 2, baseMs: 1, maxMs: 1, sleep: async () => {} };
const down = { get: async () => ({ ok: false, error: "network", detail: "caído" }) };
const approvals = (...slugs) => new Map(slugs.map((s) => [s, { ok: true, reason: "aprobado" }]));
const run = (articles, web, extra = {}) => driftCheck({ articles, approvals: approvals(...articles.map((a) => a.meta.slug)), registry, web, now: NOW, retry, ...extra });

test("todas las citas coinciden con el candado: OK y salida 0", async () => {
  const s = await scenario({ now: NOW });
  const r = await run([s.art], fixtureClient());
  assert.deepEqual([r.articles[0].state, r.exit, r.summary.ok], [STATES.ok, 0, 1]);
  assert.deepEqual(r.articles[0].findings, []);
});

test("la fuente cambió o contradice la cita o la cita no se puede comprobar: REVISION_JURIDICA_NECESARIA y salida 1", async () => {
  const s = await scenario({ now: NOW });
  const changed = await run([s.art], changedClient());
  assert.deepEqual([changed.articles[0].state, changed.exit], [STATES.review, 1]);
  assert.equal(changed.articles[0].findings[0].outcome, "changed");
  // Contradicción: el registro cambió tras el candado.
  const modified = { ...registry, sources: registry.sources.map((e) => (e.id === insst.id ? { ...e, title: "Otro título" } : e)) };
  const contradicted = await driftCheck({ articles: [s.art], approvals: approvals("tema"), registry: modified, web: fixtureClient(), now: NOW, retry });
  assert.deepEqual([contradicted.articles[0].findings[0].outcome, contradicted.exit], ["contradicted", 1]);
  // Cita sin candado.
  const noLock = { ...s.citation };
  delete noLock.lock;
  const unchecked = await run([{ meta: { ...s.art.meta, citations: [noLock] }, body: s.art.body }], fixtureClient());
  assert.deepEqual([unchecked.articles[0].findings[0].outcome, unchecked.exit], ["unchecked", 1]);
});

test("una fuente que no responde queda INCONCLUSO con salida 3: nunca OK ni salida 0", async () => {
  const s = await scenario({ now: NOW });
  const r = await run([s.art], down);
  assert.deepEqual([r.articles[0].state, r.exit], [STATES.inconclusive, 3]);
  assert.notEqual(r.exit, 0);
  assert.equal(r.summary.ok, 0);
});

test("un error inesperado del cliente tampoco es un éxito", async () => {
  const s = await scenario({ now: NOW });
  const r = await run([s.art], { get: () => { throw new TypeError("boom"); } });
  assert.deepEqual([r.articles[0].state, r.exit], [STATES.inconclusive, 3]);
});

test("precedencia: la revisión jurídica manda sobre lo inconcluso, y lo inconcluso sobre lo OK", async () => {
  const s = await scenario({ now: NOW });
  const a = await scenario({ now: NOW, entry: aepd });
  const insstOk = { meta: { ...s.art.meta, slug: "a-insst-ok" }, body: "x" };
  const aepdDown = { meta: { ...a.art.meta, slug: "b-aepd-caida" }, body: "y" };
  const insstChanged = { meta: { ...s.art.meta, slug: "c-insst-cambiada", citations: [webCitation(insst, { ...s.citation.lock, content_sha256: "f".repeat(64), text_sha256: "f".repeat(64) })] }, body: "z" };
  // INSST responde bien; la AEPD no responde.
  const ok = fixtureClient();
  const routed = { get: async (url, authority) => (url.includes("aepd.es") ? { ok: false, error: "network", detail: "caído" } : ok.get(url, authority)) };
  const r1 = await run([insstOk, aepdDown], routed);
  assert.deepEqual([Object.fromEntries(r1.articles.map((x) => [x.slug, x.state])), r1.exit], [{ "a-insst-ok": STATES.ok, "b-aepd-caida": STATES.inconclusive }, 3]);
  const r2 = await run([insstOk, aepdDown, insstChanged], routed);
  assert.equal(r2.exit, 1, "con una revisión jurídica necesaria, la salida es 1 aunque haya inconclusos");
  const r3 = await run([insstOk, insstChanged], routed);
  assert.deepEqual([r3.articles.map((x) => x.state), r3.exit], [[STATES.ok, STATES.review], 1]);
});

test("un artículo aprobado cuya firma ya no es válida necesita revisión aunque sus citas coincidan", async () => {
  const s = await scenario({ now: NOW });
  const r = await driftCheck({ articles: [s.art], approvals: new Map([["tema", { ok: false, reason: "firma inválida" }]]), registry, web: fixtureClient(), now: NOW, retry });
  assert.deepEqual([r.articles[0].state, r.exit, r.articles[0].findings[0].kind], [STATES.review, 1, "aprobacion"]);
  const missing = await driftCheck({ articles: [s.art], approvals: new Map(), registry, web: fixtureClient(), now: NOW, retry });
  assert.equal(missing.exit, 1);
});

test("las excepciones firmadas no se aplican a artículos publicados", async () => {
  const s = await scenario({ now: NOW });
  // driftCheck no acepta `exceptions`: aunque se le pase, no tienen efecto.
  const r = await driftCheck({ articles: [s.art], approvals: approvals("tema"), registry, web: down, now: NOW, retry, exceptions: { recordsFor: () => { throw new Error("no debería consultarse"); } } });
  assert.deepEqual([r.articles[0].state, r.exit], [STATES.inconclusive, 3]);
  assert.ok(!JSON.stringify(r).includes("REVISION_EXCEPCIONAL"));
});

test("presupuesto: lo que no cabe se marca NO_COMPROBADO (salida 1), nunca se omite en silencio ni se hace red por ello", async () => {
  const s = await scenario({ now: NOW });
  const two = { meta: { ...s.art.meta, slug: "dos", citations: [s.citation, { ...s.citation, id: "g2" }] }, body: "x" };
  const one = { meta: { ...s.art.meta, slug: "uno", citations: [s.citation] }, body: "y" };
  let calls = 0;
  const counting = { get: async (url, authority) => (calls++, fixtureClient().get(url, authority)) };
  const r = await run([one, two], counting, { maxCitations: 2 });
  const bySlug = Object.fromEntries(r.articles.map((a) => [a.slug, a.state]));
  assert.deepEqual(bySlug, { dos: STATES.ok, uno: STATES.unchecked }, "orden por slug: el primero consume el presupuesto y el segundo no cabe");
  assert.equal(r.exit, 1);
  assert.equal(r.summary.unchecked, 1);
  assert.ok(DEFAULT_MAX_CITATIONS > 0);
  // Un artículo sin citas cuenta como una (no se salta el presupuesto) y se marca como necesitado de revisión.
  const none = await run([{ meta: { ...s.art.meta, slug: "vacio", citations: [] }, body: "z" }], fixtureClient());
  assert.equal(none.exit, 1);
});

test("sin artículos publicados no hay nada que comprobar (0) y el informe es determinista", async () => {
  const empty = await run([], fixtureClient());
  assert.deepEqual([empty.exit, empty.articles], [0, []]);
  const s = await scenario({ now: NOW });
  const a = await run([s.art, { ...s.art, meta: { ...s.art.meta, slug: "aaa" } }], fixtureClient());
  assert.deepEqual(a.articles.map((x) => x.slug), ["aaa", "tema"]);
  assert.equal(a.generated_at, NOW.toISOString());
});
