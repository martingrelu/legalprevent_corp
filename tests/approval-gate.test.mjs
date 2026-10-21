// F2.4: approve.mjs no firma una aprobación si las citas del artículo no superan la puerta (offline + en vivo, estricta).
// Claves SSH efímeras y clientes simulados con respuestas reales recortadas; nada de red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAMESPACE, evaluateApproval, loadRecords, signStatement } from "../seo-engine/approval-signature.mjs";
import { EXCEPTIONAL_PHRASE, approveArticle, prepareApproval } from "../seo-engine/approve.mjs";
import { contentHash } from "../seo-engine/blog-render.mjs";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { bindingFor } from "../seo-engine/sources/exceptions.mjs";
import { DAY, IDENTITY, genKey, insst, iso, lopd, registry, signedRecord, webLockAt, fixtureClient } from "./helpers/exceptions-fixture.mjs";

const NOW = new Date("2026-10-21T12:00:00Z");
const TODAY = "2026-10-21";
const boeFx = (n) => readFileSync(new URL(`./fixtures/boe/${n}`, import.meta.url), "utf8");
const parts = { meta: parseMetadata(boeFx("metadatos-BOE-A-2018-16673.json")), index: parseIndex(boeFx("indice-BOE-A-2018-16673.json")), block: parseBlock(boeFx("bloque-BOE-A-2018-16673-a5.xml")) };
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
const boeLock = () => structuredClone(evaluateBoe({ entry: lopd, citation: { locator: { article: "5" }, quote: QUOTE }, ...parts, now: NOW }).lock);
const boeCite = (patch = {}) => ({ id: "c1", source: lopd.id, type: "norma", locator: { article: "5" }, quote: QUOTE, lock: boeLock(), ...patch });
const retry = { attempts: 2, baseMs: 1, maxMs: 1, sleep: async () => {} };

// Cliente BOE simulado con contador de llamadas.
function boeClient({ fail = false } = {}) {
  const state = { calls: 0 };
  const gate = () => { state.calls++; if (fail) throw new Error("HTTP 503"); };
  return { state, metadata: async () => (gate(), parts.meta), index: async () => parts.index, block: async () => parts.block };
}
const webDown = { get: async () => ({ ok: false, error: "network", detail: "caído" }) };

const meta = (citations, patch = {}) => ({ slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "approved", approved_at: TODAY, citations, ...patch });
function project({ citations = [boeCite()], metaPatch = {}, body = "Texto sin referencias normativas.", withRegistry = true, key = genKey("approver") } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lp-gate-"));
  for (const d of ["content/blog/approvals", "content/sources", "seo-engine"]) mkdirSync(join(root, d), { recursive: true });
  const m = meta(citations, metaPatch);
  writeFileSync(join(root, "content/blog/tema.md"), `---\n${JSON.stringify(m)}\n---\n${body}`);
  if (withRegistry) writeFileSync(join(root, "content/sources/registry.json"), JSON.stringify(registry));
  writeFileSync(join(root, "seo-engine/allowed_signers"), key.allowedSigners);
  return { root, key, sign: (statement) => signStatement(statement, key.priv) };
}
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => readdirSync(d).sort().forEach((n) => { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : out.push(`${p}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`); });
  walk(dir);
  return out.join("\n");
};
const approve = (p, extra = {}) => approveArticle({ root: p.root, slug: "tema", identity: IDENTITY, sign: p.sign, now: NOW, gateOptions: { boe: boeClient(), web: fixtureClient(), retry }, ...extra });
const refused = async (p, pattern, extra = {}) => {
  const before = snapshot(p.root);
  await assert.rejects(approve(p, extra), pattern);
  assert.equal(snapshot(p.root), before, "no se escribe nada cuando no se firma");
};

test("citas verificadas offline y en vivo: se firma y la aprobación resultante es válida para el contenido actual", async () => {
  const p = project();
  const { path, record, gate } = await approve(p);
  assert.ok(existsSync(path));
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.exceptional, []);
  assert.equal(record.action, "approve");
  const { meta: m, body } = (await import("../seo-engine/blog-render.mjs")).parseSource(readFileSync(join(p.root, "content/blog/tema.md"), "utf8"), "tema.md");
  const result = evaluateApproval({ meta: m, body }, loadRecords(join(p.root, "content/blog/approvals"), "tema"), { allowedSigners: p.key.allowedSigners, identity: IDENTITY, pinnedFingerprint: p.key.fingerprint, now: NOW });
  assert.equal(result.ok, true, result.reason);
});

test("fallos OFFLINE (cita editada, sin candado, sin citas, candado viejo, referencia sin cita, sin registro): no se firma y no se sale a la red", async () => {
  const noLock = (({ lock, ...rest }) => (void lock, rest))(boeCite());
  const cases = {
    "cita editada tras el candado": { citations: [boeCite({ quote: `${QUOTE} y se prohíbe todo` })] },
    "sin candado": { citations: [noLock] },
    "sin citas": { citations: [] },
    "candado de más de 30 días": { citations: [boeCite({ lock: { ...boeLock(), verified_at: "2026-08-01" } })] },
    "referencia normativa sin cita": { body: "Según la Ley Orgánica 99/2020 hay que hacerlo." },
    "registro ausente": { withRegistry: false },
  };
  for (const [name, config] of Object.entries(cases)) {
    const p = project(config);
    const boe = boeClient();
    await refused(p, /no se firma[\s\S]*offline|registro/i, { gateOptions: { boe, web: fixtureClient(), retry } });
    assert.equal(boe.state.calls, 0, `${name}: sin red`);
  }
});

test("fallos EN VIVO: BOE inaccesible, candado manipulado o fuente que contradice: no se firma (BOE nunca excepcionable)", async () => {
  const p = project();
  await refused(p, /EN VIVO[\s\S]*UNREACHABLE/, { gateOptions: { boe: boeClient({ fail: true }), web: fixtureClient(), retry } });
  const forged = project({ citations: [boeCite({ lock: { ...boeLock(), text_sha256: "0".repeat(64) } })] });
  await refused(forged, /EN VIVO[\s\S]*CONTRADICTED/);
  // Un 503 persistente del BOE no sugiere excepción (no existe para el BOE).
  await assert.rejects(approve(p, { gateOptions: { boe: boeClient({ fail: true }), web: fixtureClient(), retry } }), (error) => !/except\.mjs/.test(error.message));
});

test("un error técnico de la puerta (excepción inesperada, puerta que lanza) nunca permite firmar", async () => {
  const p = project();
  await refused(p, /boom/, { gate: async () => { throw new Error("boom"); } });
  await refused(p, /no se firma/, { gate: async () => ({ ok: false, stage: "x", problems: ["fallo"], exceptional: [] }) });
  await refused(p, /./, { gateOptions: { boe: { metadata: () => { throw new TypeError("raro"); } }, web: fixtureClient(), retry } });
  // Si la propia comprobación en vivo lanza (p. ej. no se puede crear el cliente), la puerta lo trata como "no firmar".
  await refused(p, /la comprobación en vivo falló[\s\S]*sin cliente/, { gateOptions: { clients: { boe: () => { throw new Error("sin cliente"); }, web: () => fixtureClient() }, retry } });
  // Una puerta que devuelve algo sin `ok: true` no firma.
  await refused(p, /./, { gate: async () => ({ stage: "x", problems: [], exceptional: [] }) });
});

test("AEPD/INSST inaccesible: sin excepción no se firma (con pista de except.mjs); con excepción vigente solo con la palabra EXCEPCIONAL", async () => {
  const lock = await webLockAt(insst, NOW);
  const cite = { id: "g1", source: insst.id, type: "criterio", locator: { section: "Resumen" }, lock };
  const ack = { review_ack: lock.reasons.map((reason) => ({ citation: "g1", reason, note: "Revisada por el responsable." })) };
  const p = project({ citations: [cite], metaPatch: ack });
  await refused(p, /except\.mjs tema g1/, { gateOptions: { boe: boeClient(), web: webDown, retry } });
  // Excepción firmada por el responsable (misma clave) para exactamente este contenido y candado.
  const art = (await import("../seo-engine/blog-render.mjs")).parseSource(readFileSync(join(p.root, "content/blog/tema.md"), "utf8"), "tema.md");
  const binding = bindingFor({ meta: art.meta, body: art.body, citation: art.meta.citations[0], entry: insst });
  const rec = signedRecord({ binding, issued_at: iso(NOW.getTime() - 3600_000), expires_at: iso(NOW.getTime() + 5 * DAY), key: p.key });
  mkdirSync(join(p.root, "content/blog/exceptions/tema"), { recursive: true });
  writeFileSync(join(p.root, "content/blog/exceptions/tema", rec.file), JSON.stringify(rec.record));
  const opts = { gateOptions: { boe: boeClient(), web: webDown, retry } };
  await refused(p, /REVISION_EXCEPCIONAL[\s\S]*EXCEPCIONAL/, opts);
  await refused(p, /REVISION_EXCEPCIONAL/, { ...opts, exceptionalTyped: "si" });
  const done = await approve(p, { ...opts, exceptionalTyped: EXCEPTIONAL_PHRASE });
  assert.equal(done.gate.exceptional.length, 1);
  assert.equal(done.record.action, "approve");
  // La excepción NO se convierte en verified: el estado sigue siendo el suyo.
  assert.equal(done.gate.live.items[0].outcome, "exceptional_review");
});

test("prepareApproval conserva las reglas previas: estado, fecha de hoy, hash actual y --sha256 solo para revocar", async () => {
  const ok = project();
  const run = (p, extra = {}) => prepareApproval({ root: p.root, slug: "tema", identity: IDENTITY, now: NOW, gateOptions: { boe: boeClient(), web: fixtureClient(), retry }, ...extra });
  assert.equal((await run(ok)).sha256.length, 64);
  await assert.rejects(run(project({ metaPatch: { review_status: "in_review", approved_at: undefined } })), /review_status/);
  await assert.rejects(run(project({ metaPatch: { approved_at: "2026-10-20" } })), /approved_at/);
  await assert.rejects(run(ok, { sha256: "a".repeat(64) }), /solo se admite para revocar/);
  const current = contentHash(...Object.values((await import("../seo-engine/blog-render.mjs")).parseSource(readFileSync(join(ok.root, "content/blog/tema.md"), "utf8"), "tema.md")).slice(0, 2));
  assert.equal((await run(ok, { sha256: current })).sha256, current);
});

test("la puerta es de solo lectura: ni en éxito ni en fallo modifica el artículo, el registro o las excepciones", async () => {
  const p = project();
  const before = snapshot(p.root);
  await prepareApproval({ root: p.root, slug: "tema", identity: IDENTITY, now: NOW, gateOptions: { boe: boeClient(), web: fixtureClient(), retry } });
  assert.equal(snapshot(p.root), before);
});

test("approve.mjs y except.mjs se ejecutan de verdad incluso a través de un enlace simbólico (antes salían con 0 sin hacer nada)", () => {
  const link = mkdtempSync(join(tmpdir(), "lp-link-"));
  for (const script of ["approve.mjs", "except.mjs"]) {
    const target = new URL(`../seo-engine/${script}`, import.meta.url).pathname;
    symlinkSync(target, join(link, script));
    const r = spawnSync("node", [join(link, script), "tema", "g1"], { encoding: "utf8", env: { PATH: process.env.PATH, CI: "true" }, input: "" });
    assert.equal(r.status, 1, `${script}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no se puede ejecutar en CI/, script);
  }
  rmSync(link, { recursive: true, force: true });
});
