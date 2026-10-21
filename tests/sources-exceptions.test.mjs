// Excepciones firmadas para AEPD/INSST inaccesibles (seo-engine/sources/exceptions.mjs): reutilización, alteración,
// suplantación, caducidad y límites (BOE, evidencias de fallo, candado antiguo). Claves SSH efímeras; sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExceptionRecord, eligibility, evaluateException, lockCutoff, bindingFor, bindingId, EXCEPTION_STATE, MAX_EXCEPTION_DAYS, signStatement } from "../seo-engine/sources/exceptions.mjs";
import { formatLiveItem, liveCheckArticle } from "../seo-engine/sources/live-check.mjs";
import { DAY, IDENTITY, changedClient, aepd, articleWith, genKey, insst, iso, lopd, registry, scenario, signedRecord, webCitation, webLockAt } from "./helpers/exceptions-fixture.mjs";

const NOW = new Date("2026-10-21T12:00:00Z");
const grant = (s, patch = {}) => signedRecord({ binding: s.binding, issued_at: iso(NOW.getTime() - 3600_000), expires_at: iso(NOW.getTime() + 6 * DAY), key: s.key, ...patch });
const evalWith = (s, records, patch = {}) => evaluateException({ ...s.base, records, ...patch });
const denied = (v, pattern) => { assert.equal(v.status, "NO_EXCEPCION", JSON.stringify(v)); if (pattern) assert.match(v.reasons.join(" | "), pattern); };

test("una excepción firmada, vinculada y vigente da REVISION_EXCEPCIONAL (nunca verified) y caduca a lo más tarde en 7 días", async () => {
  const s = await scenario({ now: NOW });
  const v = evalWith(s, [grant(s)]);
  assert.equal(v.status, EXCEPTION_STATE);
  assert.equal(v.status, "REVISION_EXCEPCIONAL");
  assert.notEqual(v.status, "verified");
  assert.ok(Date.parse(v.expires_at) <= NOW.getTime() + MAX_EXCEPTION_DAYS * DAY);
  assert.equal(EXCEPTION_STATE.toLowerCase().includes("verified"), false);
});

test("BOE: nunca hay excepción, ni con una firma perfecta ni con un registro manipulado", async () => {
  const s = await scenario({ now: NOW });
  assert.deepEqual(eligibility({ citation: s.citation, entry: lopd, offlineItem: s.offlineItem, now: NOW }).reasons.includes("boe_no_excepcionable"), true);
  // Registro con autoridad BOE firmado correctamente: el formato lo rechaza (solo AEPD/INSST) y la elegibilidad también.
  const forgedBinding = { ...s.binding, authority: "BOE", source: lopd.id };
  const rec = signedRecord({ binding: forgedBinding, issued_at: iso(NOW.getTime() - 1000), expires_at: iso(NOW.getTime() + DAY), key: s.key });
  denied(evalWith({ ...s, base: { ...s.base, entry: lopd } }, [rec]), /boe_no_excepcionable/);
  denied(evalWith(s, [rec]), /autoridad no excepcionable/);
  // La herramienta de creación tampoco concede una excepción a una cita del BOE.
  const root = mkdtempSync(join(tmpdir(), "lp-exroot-"));
  mkdirSync(join(root, "seo-engine"), { recursive: true });
  writeFileSync(join(root, "seo-engine/allowed_signers"), s.key.allowedSigners);
  assert.equal(eligibility({ citation: s.citation, entry: lopd, offlineItem: s.offlineItem, now: NOW }).ok, false);
});

test("evidencias de modificación, contradicción o cita incorrecta: ninguna excepción, aunque esté bien firmada", async () => {
  const s = await scenario({ now: NOW });
  const rec = grant(s);
  // Cita editada tras el candado.
  const edited = await scenario({ now: NOW, citationPatch: { quote: "texto que no está en la fuente" } });
  denied(evalWith(edited, [grant(edited)]), /evidencia:cita_editada_tras_candado/);
  // Entrada del registro modificada tras el candado.
  const changedEntry = { ...insst, title: "Título modificado" };
  denied(evalWith(s, [rec], { entry: changedEntry }), /registro_modificado|evidencia:registro_modificado/);
  // Candado manipulado (inconsistente).
  const forgedLock = await scenario({ now: NOW });
  forgedLock.citation.lock.source_sha256 = "0".repeat(64);
  const item = (await import("../seo-engine/sources/verify-citations.mjs")).verifyArticleCitations(articleWith([forgedLock.citation]), registry, { now: NOW }).items.find((i) => i.citation === "g1");
  denied(evalWith(forgedLock, [grant(forgedLock)], { offlineItem: item, citation: forgedLock.citation }));
  // Sin verificación offline disponible: se deniega.
  denied(evalWith(s, [rec], { offlineItem: undefined }), /sin_verificacion_offline/);
  // Cita sin candado.
  const noLock = { ...s.citation };
  delete noLock.lock;
  denied(evalWith(s, [rec], { citation: noLock }), /candado_invalido/);
});

test("vinculación: cambiar contenido, cita, fuente, candado o artículo invalida la excepción (no se reutiliza)", async () => {
  const s = await scenario({ now: NOW });
  const rec = grant(s);
  assert.equal(evalWith(s, [rec]).status, EXCEPTION_STATE);
  // Contenido del artículo cambiado (otro hash): el registro es de otra versión.
  denied(evalWith(s, [rec], { body: "Texto distinto." }), /sin_excepcion_firmada/);
  denied(evalWith(s, [rec], { meta: { ...s.art.meta, title: "Otro título" } }), /sin_excepcion_firmada/);
  // Candado recalculado (otro lock_sha256) aunque sea del mismo día.
  const relocked = webCitation(insst, { ...s.citation.lock, content_sha256: "a".repeat(64) });
  denied(evalWith(s, [rec], { citation: relocked }), /sin_excepcion_firmada/);
  // Otra cita del mismo artículo.
  denied(evalWith(s, [rec], { citation: { ...s.citation, id: "g2" } }), /sin_excepcion_firmada/);
  // Otra fuente (AEPD) con la misma estructura.
  const other = await scenario({ now: NOW, entry: aepd });
  denied(evalWith(other, [rec]), /sin_excepcion_firmada/);
  // Reutilizar el fichero en la carpeta de otro artículo: el slug del registro no coincide con el del artículo evaluado.
  denied(evalWith(s, [rec], { meta: { ...s.art.meta, slug: "otro-articulo" } }), /slug no coincide/);
});

test("alteración: modificar cualquier campo de un registro firmado invalida la firma y deniega (falla cerrado)", async () => {
  const s = await scenario({ now: NOW });
  const mutations = {
    "caducidad ampliada": (r) => ({ ...r, expires_at: iso(NOW.getTime() + 6.5 * DAY) }),
    "issued_at cambiado": (r) => ({ ...r, issued_at: iso(NOW.getTime() - 60_000) }),
    "identidad": (r) => ({ ...r, identity: "otra-persona" }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const base = grant(s);
    const m = mutate(base.record);
    const { recordFileName } = await import("../seo-engine/sources/exceptions.mjs");
    const v = evalWith(s, [{ file: recordFileName(m), record: m }]);
    denied(v);
    assert.match(v.reasons.join(), /firma inválida|no es de|no es de la clave/, name);
  }
  // Un registro firmado para OTRO contenido y reescrito para "encajar" con el actual: la vinculación coincide pero la firma no.
  const otherContent = { ...s.binding, content_sha256: createHash("sha256").update("otro").digest("hex") };
  const signedForOther = signedRecord({ binding: otherContent, issued_at: iso(NOW.getTime() - 3600_000), expires_at: iso(NOW.getTime() + 6 * DAY), key: s.key });
  const rewritten = { ...signedForOther.record, binding: s.binding };
  const { recordFileName } = await import("../seo-engine/sources/exceptions.mjs");
  denied(evalWith(s, [{ file: recordFileName(rewritten), record: rewritten }]), /firma inválida/);
  // Y un registro válido de otra versión del contenido simplemente no cuenta.
  denied(evalWith(s, [signedForOther]), /sin_excepcion_firmada/);
  const rec = grant(s);
  // Firma eliminada o vacía.
  const unsigned = { ...rec.record, signature: "" };
  denied(evalWith(s, [{ file: recordFileName(unsigned), record: unsigned }]), /falta la firma/);
});

test("suplantación: firma de otra clave, firma de aprobación reutilizada, huella no fijada o ausente", async () => {
  const s = await scenario({ now: NOW });
  const impostor = genKey("impostor");
  denied(evalWith(s, [grant(s, { key: impostor })]), /firma inválida|no es de la clave/);
  // Una firma de aprobación (otro espacio de nombres) sobre el mismo texto no vale como excepción.
  denied(evalWith(s, [grant(s, { namespaceOverride: "legalprevent-blog-approval" })]), /firma inválida/);
  denied(evalWith(s, [grant(s, { namespaceOverride: "git" })]), /firma inválida/);
  // La huella fijada no coincide con la clave de allowed_signers (alguien cambió el fichero).
  denied(evalWith(s, [grant(s)], { pinnedFingerprint: impostor.fingerprint }), /ancla/);
  denied(evalWith(s, [grant(s)], { pinnedFingerprint: undefined }), /ancla/);
  denied(evalWith(s, [grant(s)], { allowedSigners: impostor.allowedSigners }), /ancla/);
  // Una identidad distinta de la del responsable.
  denied(evalWith(s, [grant(s, { identity: "legalprevent-seo-bot" })]), /no es de/);
});

test("caducidad: vencida, más larga de 7 días, emitida antes del candado, futura, y límite del candado", async () => {
  const s = await scenario({ now: NOW, lockAgeDays: 5 });
  // Vigente: la caducidad efectiva es la del candado (verified_at + 7 días), no la de 7 días del registro.
  const long = signedRecord({ binding: s.binding, issued_at: iso(NOW.getTime() - 3600_000), expires_at: iso(NOW.getTime() + 6.9 * DAY), key: s.key });
  const ok = evalWith(s, [long]);
  assert.equal(ok.status, EXCEPTION_STATE);
  assert.equal(Date.parse(ok.expires_at), lockCutoff(s.citation.lock), "la caducidad respeta la antigüedad máxima del candado");
  // Pasado el límite del candado (aunque el registro siga vigente) ya no hay excepción.
  const after = new Date(lockCutoff(s.citation.lock) + 1000);
  denied(evaluateException({ ...s.base, now: after, records: [long] }), /candado_con_mas_de_7_dias/);
  // Vencida.
  denied(evalWith(s, [grant(s, { issued_at: iso(NOW.getTime() - 2 * DAY), expires_at: iso(NOW.getTime() - 1000) })]), /caducada/);
  // Más de 7 días de vigencia.
  const s1 = await scenario({ now: NOW, lockAgeDays: 0 });
  denied(evalWith(s1, [grant(s1, { expires_at: iso(NOW.getTime() + 8 * DAY) })]), /dura más de 7 días/);
  // expires_at anterior a issued_at.
  denied(evalWith(s1, [grant(s1, { issued_at: iso(NOW.getTime() - 1000), expires_at: iso(NOW.getTime() - 2000) })]), /posterior|caducada/);
  // Emitida en el futuro (más allá de la tolerancia) y anterior al candado.
  denied(evalWith(s1, [grant(s1, { issued_at: iso(NOW.getTime() + 3600_000), expires_at: iso(NOW.getTime() + 2 * DAY) })]), /futuro/);
  denied(evalWith(s1, [grant(s1, { issued_at: iso(NOW.getTime() - 3 * DAY), expires_at: iso(NOW.getTime() + DAY) })]), /antes del candado/);
  // Candado de más de 7 días: no es elegible.
  const old = await scenario({ now: NOW, lockAgeDays: 8 });
  denied(evalWith(old, [grant(old, { issued_at: iso(NOW.getTime() - 7.9 * DAY), expires_at: iso(NOW.getTime() - 1.0 * DAY) })]), /candado_con_mas_de_7_dias/);
  // Candado futuro.
  const future = await scenario({ now: NOW, lockAgeDays: -2 });
  denied(evalWith(future, [grant(future)]), /candado_futuro/);
});

test("revocación: la última firma manda, ante empate la revocación, y una concesión posterior vuelve a valer", async () => {
  const s = await scenario({ now: NOW });
  const t = (min) => iso(NOW.getTime() - min * 60_000);
  const g1 = grant(s, { issued_at: t(30), expires_at: iso(NOW.getTime() + 5 * DAY) });
  const rev = signedRecord({ action: "revoke", binding: s.binding, issued_at: t(20), key: s.key });
  denied(evalWith(s, [g1, rev]), /revocada/);
  const g2 = grant(s, { issued_at: t(10), expires_at: iso(NOW.getTime() + 5 * DAY) });
  assert.equal(evalWith(s, [g1, rev, g2]).status, EXCEPTION_STATE);
  // Empate de marca de tiempo: prevalece la revocación.
  const tieG = grant(s, { issued_at: t(5), expires_at: iso(NOW.getTime() + 5 * DAY) });
  const tieR = signedRecord({ action: "revoke", binding: s.binding, issued_at: t(5), key: s.key });
  denied(evalWith(s, [tieG, tieR]), /revocada/);
  denied(evalWith(s, [tieR, tieG]), /revocada/);
});

test("registros rotos o incoherentes deniegan toda excepción aunque haya una concesión válida", async () => {
  const s = await scenario({ now: NOW });
  const good = grant(s);
  denied(evalWith(s, [good, { file: "basura.json", record: null }]), /formato no válido/);
  denied(evalWith(s, [good, { file: "x.json", record: { ...good.record, extra: 1 } }]), /campos inesperados/);
  denied(evalWith(s, [{ file: "20260101T000000Z-grant-deadbeef.json", record: good.record }]), /nombre del fichero/);
  denied(evalWith(s, [{ file: good.file, record: { ...good.record, reason: "otra" } }]), /motivo/);
  denied(evalWith(s, [{ file: good.file, record: { ...good.record, binding: { ...good.record.binding, authority: "BOE" } } }]), /autoridad no excepcionable/);
  denied(evalWith(s, [{ file: good.file, record: { ...good.record, binding: { slug: "x" } } }]), /vinculación incompleta/);
});

test("createExceptionRecord escribe solo el registro, firma con el espacio de nombres propio y no toca artículos ni aprobaciones", async () => {
  const s = await scenario({ now: NOW });
  const root = mkdtempSync(join(tmpdir(), "lp-exroot-"));
  for (const dir of ["seo-engine", "content/blog/approvals/tema"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "seo-engine/allowed_signers"), s.key.allowedSigners);
  writeFileSync(join(root, "content/blog/tema.md"), "intacto");
  writeFileSync(join(root, "content/blog/approvals/tema/x.json"), "intacto");
  const { path, record } = createExceptionRecord({ root, action: "grant", binding: s.binding, identity: IDENTITY, now: NOW, cutoff: lockCutoff(s.citation.lock), sign: (st) => signStatement(st, s.key.priv) });
  assert.match(path, /content\/blog\/exceptions\/tema\/\d{8}T\d{6}Z-grant-[0-9a-f]{8}\.json$/);
  assert.equal(readFileSync(join(root, "content/blog/tema.md"), "utf8"), "intacto");
  assert.equal(readFileSync(join(root, "content/blog/approvals/tema/x.json"), "utf8"), "intacto");
  assert.ok(Date.parse(record.expires_at) - Date.parse(record.issued_at) <= MAX_EXCEPTION_DAYS * DAY);
  assert.equal(evalWith(s, [{ file: path.split("/").pop(), record }]).status, EXCEPTION_STATE);
  // wx: no se sobrescribe un registro existente.
  assert.throws(() => createExceptionRecord({ root, action: "grant", binding: s.binding, identity: IDENTITY, now: NOW, cutoff: lockCutoff(s.citation.lock), sign: (st) => signStatement(st, s.key.priv) }), /EEXIST|exist/);
  // Con el candado ya caducado no se puede conceder.
  assert.throws(() => createExceptionRecord({ root, action: "grant", binding: s.binding, identity: IDENTITY, now: new Date(NOW.getTime() + 10 * DAY), cutoff: lockCutoff(s.citation.lock), sign: (st) => signStatement(st, s.key.priv) }), /7 días/);
  // La clave que firma tiene que ser la de allowed_signers.
  const impostor = genKey("impostor");
  assert.throws(() => createExceptionRecord({ root, action: "revoke", binding: s.binding, identity: IDENTITY, now: new Date(NOW.getTime() + 1000), sign: (st) => signStatement(st, impostor.priv) }), /no valida|firma/);
});

test("integración con sources-live: unreachable de AEPD/INSST + excepción vigente = REVISION_EXCEPCIONAL (no bloquea, no es CONFIRMED)", async () => {
  const s = await scenario({ now: NOW });
  const down = { client: { get: async () => ({ ok: false, error: "network", detail: "caído" }) } };
  const exceptions = (records) => ({ recordsFor: () => records, allowedSigners: s.key.allowedSigners, identity: IDENTITY, pinnedFingerprint: s.key.fingerprint });
  const run = (article, ex, reg = registry) => liveCheckArticle(article, reg, { web: down.client, now: NOW, retry: { attempts: 2, baseMs: 1, maxMs: 1, sleep: async () => {} }, mode: "strict", exceptions: ex });
  const withEx = await run(s.art, exceptions([grant(s)]));
  const [item] = withEx.items;
  assert.equal(item.outcome, "exceptional_review");
  assert.equal(item.blocking, false);
  assert.equal(withEx.blocking, false);
  assert.match(formatLiveItem(item), /^REVISION_EXCEPCIONAL/);
  assert.doesNotMatch(formatLiveItem(item), /VERIFIED|CONFIRMED/i);
  assert.match(formatLiveItem(item), /NO verificada/);
  // Sin excepciones, con una excepción caducada o de otro contenido: bloquea como antes.
  for (const ex of [undefined, exceptions([]), exceptions([grant(s, { issued_at: iso(NOW.getTime() - 3 * DAY), expires_at: iso(NOW.getTime() - 1000) })])]) {
    const r = await run(s.art, ex);
    assert.deepEqual([r.items[0].outcome, r.blocking], ["unreachable", true]);
  }
  // Un error al evaluar la excepción nunca la concede.
  const broken = await run(s.art, { recordsFor: () => { throw new Error("boom"); }, allowedSigners: "", identity: IDENTITY, pinnedFingerprint: "x" });
  assert.deepEqual([broken.items[0].outcome, broken.blocking], ["unreachable", true]);
  assert.match(broken.items[0].exceptionDenied.join(), /error:boom/);
});

test("la excepción solo transforma 'unreachable': changed, contradicted y unchecked siguen bloqueando; el BOE inconcluso también", async () => {
  const s = await scenario({ now: NOW });
  const ex = { recordsFor: () => [grant(s)], allowedSigners: s.key.allowedSigners, identity: IDENTITY, pinnedFingerprint: s.key.fingerprint };
  // Fuente web accesible pero con contenido distinto al del candado: changed (no se toca).
  const changedLock = { ...s.citation.lock, content_sha256: "f".repeat(64), text_sha256: "f".repeat(64) };
  const changedArt = { meta: { ...s.art.meta, citations: [webCitation(insst, changedLock)] }, body: s.art.body };
  const okClient = (await import("./helpers/exceptions-fixture.mjs")).fixtureClient();
  const changed = await liveCheckArticle(changedArt, registry, { web: okClient, now: NOW, retry: { attempts: 1 }, exceptions: ex });
  assert.deepEqual([changed.items[0].outcome, changed.blocking], ["changed", true]);
  // Con una excepción VÁLIDA para exactamente este candado, si la fuente responde pero distinta sigue siendo `changed`.
  const okArt = { meta: { ...s.art.meta, citations: [s.citation] }, body: s.art.body };
  const withValid = await liveCheckArticle(okArt, registry, { web: changedClient(), now: NOW, retry: { attempts: 1 }, exceptions: ex });
  assert.deepEqual([withValid.items[0].outcome, withValid.blocking, withValid.items[0].exception], ["changed", true, undefined]);
  // Y si la fuente responde igual que el candado, es `confirmed` (la excepción no interviene).
  const confirmed = await liveCheckArticle(okArt, registry, { web: okClient, now: NOW, retry: { attempts: 1 }, exceptions: ex });
  assert.deepEqual([confirmed.items[0].outcome, confirmed.blocking], ["confirmed", false]);
  // Sin candado: unchecked.
  const noLockCit = { ...s.citation };
  delete noLockCit.lock;
  const unchecked = await liveCheckArticle({ meta: { ...s.art.meta, citations: [noLockCit] }, body: s.art.body }, registry, { web: okClient, now: NOW, retry: { attempts: 1 }, exceptions: ex });
  assert.deepEqual([unchecked.items[0].outcome, unchecked.blocking], ["unchecked", true]);
  // BOE inalcanzable: nunca excepcionable, aunque haya un registro "firmado" para la cita.
  const boeFx = (n) => readFileSync(new URL(`./fixtures/boe/${n}`, import.meta.url), "utf8");
  const { evaluateBoe, parseBlock, parseIndex, parseMetadata } = await import("../seo-engine/sources/adapters/boe.mjs");
  const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";
  const boeLock = evaluateBoe({ entry: lopd, citation: { locator: { article: "5" }, quote: QUOTE }, meta: parseMetadata(boeFx("metadatos-BOE-A-2018-16673.json")), index: parseIndex(boeFx("indice-BOE-A-2018-16673.json")), block: parseBlock(boeFx("bloque-BOE-A-2018-16673-a5.xml")), now: NOW }).lock;
  const boeCit = { id: "c1", source: lopd.id, type: "norma", locator: { article: "5" }, quote: QUOTE, lock: boeLock };
  const boeDown = { metadata: () => { throw new Error("HTTP 503"); } };
  const boe = await liveCheckArticle({ meta: { ...s.art.meta, citations: [boeCit] }, body: s.art.body }, registry, { boe: boeDown, now: NOW, retry: { attempts: 2, baseMs: 1, maxMs: 1, sleep: async () => {} }, exceptions: ex });
  assert.deepEqual([boe.items[0].outcome, boe.items[0].exceptionable, boe.blocking], ["unreachable", false, true]);
  // Ni siquiera se consultan los registros de excepciones para el BOE.
  let consulted = 0;
  const spy = { ...ex, recordsFor: () => { consulted++; return [grant(s)]; } };
  await liveCheckArticle({ meta: { ...s.art.meta, citations: [boeCit] }, body: s.art.body }, registry, { boe: boeDown, now: NOW, retry: { attempts: 1 }, exceptions: spy });
  assert.equal(consulted, 0);
});

test("except.mjs no se ejecuta en CI ni sin terminal interactiva", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (env) => spawnSync("node", ["seo-engine/except.mjs", "tema", "g1"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", env: { PATH: process.env.PATH, ...env }, input: "" });
  const ci = run({ CI: "true" });
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /no se puede ejecutar en CI|terminal interactiva/);
  const noTty = run({});
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /terminal interactiva/);
});
