// Esquema del registro de fuentes, de las citas, de los candados y de los reconocimientos. Sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BINDING_BY_KIND,
  FAILED_REASONS,
  REVIEW_REASONS,
  ackProblems,
  assertRegistry,
  blockIdFor,
  citationProblems,
  ENGINE_BY_AUTHORITY,
  NORMATIVE_BINDINGS,
  locatorFitsAuthority,
  lockProblems,
  registryEntryHash,
  registryProblems,
  urlProblem,
} from "../seo-engine/sources/schema.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const registry = JSON.parse(read("content/sources/registry.json"));
const clone = (value) => structuredClone(value);
const TODAY = "2026-10-21";
const boe = () => clone(registry.sources.find((entry) => entry.id === "boe-lo-3-2018"));
const guia = () => ({
  id: "aepd-guia-ejemplo",
  authority: "AEPD",
  kind: "guia",
  binding: "no_vinculante",
  title: "Guía de ejemplo de la AEPD",
  official_ref: { reference: "Guía de ejemplo" },
  urls: { canonical: "https://www.aepd.es/guias/ejemplo.pdf" },
  added_at: "2026-10-01",
});
const problemsFor = (entry) => registryProblems({ version: 1, sources: [entry] }, { today: TODAY });
const reg = (patch) => problemsFor({ ...boe(), ...patch });

test("el registro inicial es válido y cada fuente deriva su naturaleza jurídica de su tipo", () => {
  assert.deepEqual(registryProblems(registry, { today: TODAY }), []);
  assert.doesNotThrow(() => assertRegistry(registry, { today: TODAY }));
  const boes = registry.sources.filter((entry) => entry.authority === "BOE");
  const web = registry.sources.filter((entry) => entry.authority !== "BOE");
  assert.ok(boes.length >= 6 && web.length >= 4);
  for (const entry of registry.sources) {
    assert.equal(entry.binding, BINDING_BY_KIND[entry.kind]);
    assert.equal(new URL(entry.urls.canonical).hostname, { BOE: "www.boe.es", AEPD: "www.aepd.es", INSST: "www.insst.es" }[entry.authority]);
  }
  for (const entry of boes) {
    assert.equal(entry.kind, "texto_consolidado");
    assert.match(entry.official_ref.boe_id, /^BOE-A-\d{4}-\d+$/);
  }
  for (const entry of web) {
    assert.equal(entry.kind, "guia");
    assert.equal(entry.binding, "no_vinculante");
    assert.ok(entry.official_ref.reference.length >= 8, "título oficial");
  }
  assert.equal(new Set(registry.sources.map((s) => s.id)).size, registry.sources.length, "ids únicos");
});

test("las cuatro naturalezas jurídicas son distintas y solo la norma puede apoyar lo que dice la norma", () => {
  assert.deepEqual(BINDING_BY_KIND, {
    disposicion: "vinculante",
    texto_consolidado: "informativo",
    criterio_administrativo: "criterio_administrativo",
    guia: "no_vinculante",
  });
  assert.deepEqual(NORMATIVE_BINDINGS, ["vinculante", "informativo"]);
  assert.deepEqual(ENGINE_BY_AUTHORITY, { BOE: "boe-api-v1", AEPD: "web-v1", INSST: "web-v1" });
  assert.deepEqual(problemsFor({ ...boe(), kind: "disposicion", binding: "vinculante" }), []);
  assert.match(reg({ binding: "vinculante" })[0], /binding debe ser "informativo"/);
  assert.match(problemsFor({ ...guia(), binding: "vinculante" }).join(), /binding debe ser "no_vinculante"/);
  assert.deepEqual(problemsFor(guia()), []);
  // Criterio administrativo (informes, resoluciones, criterios de una autoridad): solo AEPD, con su propia naturaleza.
  const criterio = { ...guia(), id: "aepd-informe-ejemplo", kind: "criterio_administrativo", binding: "criterio_administrativo" };
  assert.deepEqual(problemsFor(criterio), []);
  assert.match(problemsFor({ ...criterio, binding: "no_vinculante" }).join(), /binding debe ser "criterio_administrativo"/);
  assert.match(problemsFor({ ...criterio, authority: "INSST", urls: { canonical: "https://www.insst.es/x" } }).join(), /INSST solo admite kind guia/);
  assert.match(reg({ kind: "criterio_administrativo", binding: "criterio_administrativo" }).join(), /BOE solo admite kind/);
});

test("las URL de documento e índice solo existen en AEPD e INSST", () => {
  const withDocument = { ...guia(), urls: { canonical: "https://www.aepd.es/guias/ejemplo.pdf", index: "https://www.aepd.es/guias-y-herramientas/guias", document: "https://www.aepd.es/guias/ejemplo.pdf" } };
  assert.deepEqual(problemsFor(withDocument), []);
  assert.match(reg({ urls: { ...boe().urls, document: "https://www.boe.es/x.pdf" } }).join(), /urls: clave no permitida "document"/);
  assert.match(problemsFor({ ...guia(), urls: { ...guia().urls, consolidated: "https://www.aepd.es/x" } }).join(), /urls: clave no permitida "consolidated"/);
  assert.match(problemsFor({ ...guia(), urls: { ...guia().urls, index: "https://example.com/guias" } }).join(), /urls.index/);
  assert.match(problemsFor({ ...guia(), urls: { ...guia().urls, document: "http://www.aepd.es/x.pdf" } }).join(), /urls.document/);
});

test("el hash de la entrada del registro cambia con cualquier modificación, incluida una reclasificación", () => {
  const base = registryEntryHash(boe());
  assert.equal(registryEntryHash(boe()), base, "estable");
  assert.equal(registryEntryHash({ ...boe(), official_ref: { ...boe().official_ref } }), base, "no depende del orden de las claves");
  assert.equal(registryEntryHash(Object.fromEntries(Object.entries(boe()).reverse())), base);
  for (const patch of [{ title: "Otro título distinto" }, { kind: "disposicion", binding: "vinculante" }, { urls: { canonical: "https://www.boe.es/otra" } }]) {
    assert.notEqual(registryEntryHash({ ...boe(), ...patch }), base, JSON.stringify(patch).slice(0, 40));
  }
});

test("el registro es estricto: claves desconocidas, duplicados y formas inválidas se rechazan", () => {
  assert.match(reg({ verified: true }).join(), /clave no permitida "verified"/);
  assert.match(problemsFor({ ...boe(), official_ref: { ...boe().official_ref, verified: true } }).join(), /official_ref: clave no permitida/);
  assert.match(registryProblems({ version: 1, sources: [boe(), boe()] }, { today: TODAY }).join(), /id duplicado/);
  assert.match(reg({ id: "Boe LOPD" }).join(), /id inválido/);
  assert.match(reg({ authority: "CGPJ" }).join(), /authority debe ser/);
  assert.match(reg({ kind: "guia", binding: "no_vinculante" }).join(), /BOE solo admite kind/);
  assert.match(problemsFor({ ...guia(), kind: "texto_consolidado", binding: "informativo" }).join(), /AEPD solo admite kind guia/);
  assert.match(reg({ title: "" }).join(), /falta title/);
  assert.match(reg({ added_at: "2026-02-31" }).join(), /added_at/);
  assert.match(reg({ added_at: "2027-01-01" }).join(), /added_at/);
  assert.match(registryProblems({ version: 2, sources: [] })[0], /debe ser \{ version: 1/);
  assert.match(registryProblems([])[0], /debe ser \{ version: 1/);
  assert.match(registryProblems({ version: 1, sources: [boe()], extra: 1 }, { today: TODAY }).join(), /clave no permitida "extra"/);
});

test("los identificadores y las URL deben ser oficiales: https, host exacto y sin credenciales", () => {
  assert.match(reg({ official_ref: { ...boe().official_ref, boe_id: "BOE-2018-1" } }).join(), /boe_id inválido/);
  assert.match(reg({ official_ref: { ...boe().official_ref, numero_oficial: "3-2018" } }).join(), /numero_oficial/);
  assert.match(reg({ official_ref: { ...boe().official_ref, eli: "https://www.boe.es.evil.com/eli/x" } }).join(), /eli/);
  assert.match(problemsFor({ ...guia(), official_ref: {} }).join(), /official_ref.reference/);
  for (const bad of ["http://www.boe.es/x", "https://example.com/x", "https://www.boe.es.evil.com/x", "https://evil.com/www.boe.es", "https://u:p@www.boe.es/x", "no es url", "https://boe.es/x"]) {
    assert.ok(urlProblem(bad, "BOE"), bad);
    assert.match(reg({ urls: { canonical: bad } }).join(), /urls.canonical/, bad);
  }
  assert.equal(urlProblem("https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673", "BOE"), null);
  assert.match(urlProblem("https://www.boe.es/x", "AEPD"), /no es oficial para AEPD/);
  assert.equal(urlProblem("https://www.insst.es/guias-tecnicas-transversales", "INSST"), null);
});

const validLock = () => ({
  verified_at: "2026-10-21",
  engine: "boe-api-v1",
  source_sha256: "c".repeat(64),
  boe_id: "BOE-A-2018-16673",
  block_id: "a5",
  block_fecha_actualizacion: "20181206",
  norma_fecha_actualizacion: "20261008T073957Z",
  version_fecha_vigencia: "20181207",
  text_sha256: "a".repeat(64),
  quote_sha256: "b".repeat(64),
  status: "verified",
  reasons: [],
});
const validCitation = () => ({ id: "c1", source: "boe-lo-3-2018", type: "norma", locator: { article: "5" }, quote: "deber de confidencialidad al que se refiere" });

const validWebLock = () => ({
  verified_at: "2026-10-21",
  engine: "web-v1",
  source_sha256: "c".repeat(64),
  final_url: "https://www.insst.es/documentacion/catalogo-de-publicaciones/guia",
  http_status: 200,
  content_type: "text/html",
  content_sha256: "a".repeat(64),
  text_sha256: "b".repeat(64),
  last_modified: "Thu, 19 Nov 2020 15:39:23 GMT",
  document: { final_url: "https://www.insst.es/documents/94886/guia.pdf", content_type: "application/pdf", content_sha256: "d".repeat(64), last_modified: null },
  quote_sha256: null,
  status: "needs_review",
  reasons: ["vigencia_no_acreditable", "solo_existencia"],
});

test("el candado web exige sus campos propios y no admite los del BOE", () => {
  assert.deepEqual(lockProblems(validWebLock()), []);
  assert.deepEqual(lockProblems({ ...validWebLock(), document: null, text_sha256: null, last_modified: null }), []);
  assert.match(lockProblems({ ...validWebLock(), boe_id: "BOE-A-2018-16673" }).join(), /clave no permitida "boe_id"/);
  assert.match(lockProblems({ ...validLock(), final_url: "https://www.boe.es/x" }).join(), /clave no permitida "final_url"/);
  assert.match(lockProblems({ ...validWebLock(), http_status: 403 }).join(), /http_status debe ser 200/);
  assert.match(lockProblems({ ...validWebLock(), final_url: "http://www.insst.es/x" }).join(), /final_url/);
  assert.match(lockProblems({ ...validWebLock(), content_sha256: "abc" }).join(), /content_sha256/);
  assert.match(lockProblems({ ...validWebLock(), content_type: "texto" }).join(), /content_type/);
  assert.match(lockProblems({ ...validWebLock(), document: { final_url: "https://www.insst.es/x", content_type: "application/pdf", content_sha256: "zz" } }).join(), /document.content_sha256/);
  assert.match(lockProblems({ ...validWebLock(), document: { ...validWebLock().document, extra: 1 } }).join(), /clave no permitida "extra"/);
  assert.match(lockProblems({ ...validWebLock(), source_sha256: undefined }).join(), /source_sha256/);
  assert.match(lockProblems({ ...validLock(), source_sha256: undefined }).join(), /source_sha256/);
  assert.match(lockProblems({ ...validWebLock(), engine: "otro" }).join(), /engine/);
});

test("los localizadores son del tipo que admite cada fuente: artículo o bloque en el BOE, sección o página en AEPD/INSST", () => {
  assert.equal(locatorFitsAuthority({ article: "5" }, "BOE"), true);
  assert.equal(locatorFitsAuthority({ block: "da1" }, "BOE"), true);
  assert.equal(locatorFitsAuthority({ section: "Introducción" }, "BOE"), false);
  assert.equal(locatorFitsAuthority({ section: "Introducción" }, "INSST"), true);
  assert.equal(locatorFitsAuthority({ page: 12 }, "AEPD"), true);
  assert.equal(locatorFitsAuthority({ article: "5" }, "AEPD"), false);
  assert.deepEqual(citationProblems({ ...validCitation(), locator: { section: "3. Responsabilidades" } }), []);
  assert.deepEqual(citationProblems({ ...validCitation(), locator: { page: 12 } }), []);
  assert.match(citationProblems({ ...validCitation(), locator: { section: "ab" } }).join(), /locator.section/);
  assert.match(citationProblems({ ...validCitation(), locator: { page: 0 } }).join(), /locator.page/);
  assert.match(citationProblems({ ...validCitation(), locator: { page: "12" } }).join(), /locator.page/);
  assert.match(citationProblems({ ...validCitation(), locator: { page: 12, section: "Intro" } }).join(), /exactamente uno/);
});

test("una cita válida pasa y las inválidas se rechazan con su motivo", () => {
  assert.deepEqual(citationProblems(validCitation()), []);
  assert.deepEqual(citationProblems({ ...validCitation(), lock: validLock() }), []);
  assert.deepEqual(citationProblems({ ...validCitation(), locator: { block: "da1" } }), []);
  assert.match(citationProblems({ ...validCitation(), verified: true }).join(), /clave no permitida "verified"/);
  assert.match(citationProblems({ ...validCitation(), type: "opinion" }).join(), /type debe ser/);
  assert.match(citationProblems({ ...validCitation(), id: "C 1" }).join(), /id inválido/);
  assert.match(citationProblems({ ...validCitation(), locator: { article: "5", block: "a5" } }).join(), /exactamente uno/);
  assert.match(citationProblems({ ...validCitation(), locator: {} }).join(), /exactamente uno/);
  assert.match(citationProblems({ ...validCitation(), locator: { article: "5; DROP" } }).join(), /locator.article inválido/);
  assert.match(citationProblems({ ...validCitation(), locator: { block: "../x" } }).join(), /locator.block inválido/);
  assert.match(citationProblems({ ...validCitation(), quote: "corta" }).join(), /quote debe tener/);
  assert.match(citationProblems({ ...validCitation(), quote: "x".repeat(801) }).join(), /quote debe tener/);
  assert.match(citationProblems("texto").join(), /debe ser un objeto/);
});

test("el candado es estricto: estado coherente con sus motivos y sin campos ajenos", () => {
  assert.deepEqual(lockProblems(validLock()), []);
  assert.deepEqual(lockProblems({ ...validLock(), quote_sha256: null, status: "needs_review", reasons: ["solo_existencia"] }), []);
  assert.match(lockProblems({ ...validLock(), status: "verified", reasons: ["solo_existencia"] }).join(), /verified no puede llevar motivos/);
  assert.match(lockProblems({ ...validLock(), status: "needs_review", reasons: [] }).join(), /necesita motivos/);
  assert.match(lockProblems({ ...validLock(), status: "needs_review", reasons: ["cita_no_encontrada"] }).join(), /solo admite motivos de revisión/);
  assert.match(lockProblems({ ...validLock(), status: "failed" }).join(), /status debe ser/);
  assert.match(lockProblems({ ...validLock(), text_sha256: "abc" }).join(), /text_sha256/);
  assert.match(lockProblems({ ...validLock(), engine: "otro" }).join(), /engine/);
  assert.match(lockProblems({ ...validLock(), verified_at: "2026-13-01" }).join(), /verified_at/);
  assert.match(lockProblems({ ...validLock(), boe_id: "x" }).join(), /boe_id/);
  assert.match(lockProblems({ ...validLock(), extra: 1 }).join(), /clave no permitida "extra"/);
  assert.match(lockProblems(null).join(), /debe ser un objeto/);
});

test("los reconocimientos exigen motivo válido y una nota que explique la decisión", () => {
  assert.deepEqual(ackProblems(undefined), []);
  assert.deepEqual(ackProblems([{ citation: "c1", reason: "solo_existencia", note: "Revisado el artículo completo en el BOE." }]), []);
  assert.deepEqual(ackProblems([{ citation: "(cuerpo)", reason: "referencia_sin_cita", note: "Mención histórica, sin afirmación normativa." }]), []);
  assert.match(ackProblems([{ citation: "c1", reason: "solo_existencia", note: "ok" }]).join(), /note debe explicar/);
  assert.match(ackProblems([{ citation: "c1", reason: "cita_no_encontrada", note: "No debería poder reconocerse." }]).join(), /reason debe ser un motivo de revisión/);
  assert.match(ackProblems([{ citation: "C 1", reason: "solo_existencia", note: "Nota suficiente aquí." }]).join(), /citation inválida/);
  assert.match(ackProblems([{ citation: "c1", reason: "solo_existencia", note: "Nota suficiente aquí.", extra: 1 }]).join(), /clave no permitida/);
  assert.match(ackProblems({}).join(), /debe ser una lista/);
});

test("los motivos de fallo y de revisión son disjuntos, sin duplicados, y un fallo nunca es reconocible", () => {
  assert.equal(new Set(FAILED_REASONS).size, FAILED_REASONS.length);
  assert.equal(new Set(REVIEW_REASONS).size, REVIEW_REASONS.length);
  assert.deepEqual(FAILED_REASONS.filter((reason) => REVIEW_REASONS.includes(reason)), []);
  for (const reason of ["cita_no_encontrada", "norma_derogada", "sin_candado", "guia_como_norma", "ack_sin_uso"]) assert.ok(FAILED_REASONS.includes(reason), reason);
});

test("blockIdFor traduce el localizador al bloque del BOE", () => {
  assert.equal(blockIdFor({ article: "5" }), "a5");
  assert.equal(blockIdFor({ article: "5 bis" }), "a5bis");
  assert.equal(blockIdFor({ article: "34" }), "a34");
  assert.equal(blockIdFor({ block: "ti" }), "ti");
});
