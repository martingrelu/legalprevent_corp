// Aprobación individual por firma SSH desprendida (seo-engine/approval-signature.mjs, approve.mjs).
// Usa claves SSH efímeras generadas en un directorio temporal; no toca ~/.ssh ni la red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../seo-engine/blog-render.mjs";
import {
  NAMESPACE,
  allowedSignersFingerprint,
  buildRecord,
  checkAllowedSigners,
  evaluateApproval,
  loadRecords,
  nowTimestamp,
  recordFileName,
  signStatement,
  statementFor,
  verifySignedApprovals,
} from "../seo-engine/approval-signature.mjs";
import { assertInteractive, assertTimestampAfterLastRecord, createRecord } from "../seo-engine/approve.mjs";

const work = mkdtempSync(join(tmpdir(), "lp-sig-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const ID = "martingrelu";
const NOW = new Date("2026-10-21T12:00:00Z");

function newKey(name) {
  const priv = join(work, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", priv]);
  const pub = readFileSync(`${priv}.pub`, "utf8").trim();
  const fp = execFileSync("ssh-keygen", ["-l", "-f", `${priv}.pub`], { encoding: "utf8" }).match(/(SHA256:\S+)/)[1];
  return { priv, pub, fp, allowed: `${ID} namespaces="${NAMESPACE}" ${pub}\n` };
}
const keyA = newKey("a");
const keyB = newKey("b");

const META = {
  slug: "tema-real",
  title: "Tema real",
  description: "Descripción.",
  date_published: "2026-10-01",
  date_modified: "2026-10-15",
  review_status: "approved",
  approved_at: "2026-10-21",
};
const BODY = "Texto de prueba.";
const article = (patch = {}, body = BODY) => ({ meta: { ...META, ...patch }, body });
const options = (key = keyA, extra = {}) => ({ allowedSigners: key.allowed, identity: ID, pinnedFingerprint: key.fp, now: NOW, ...extra });

// Registro firmado para el contenido de `art`. `namespace` permite probar firmas con otro uso.
function signed({ action = "approve", art = article(), key = keyA, timestamp = "2026-10-21T10:00:00Z", namespace = NAMESPACE, sha256 } = {}) {
  const fields = { action, slug: art.meta.slug, sha256: sha256 ?? contentHash(art.meta, art.body), timestamp };
  const statement = statementFor(fields);
  let signature;
  if (namespace === NAMESPACE) signature = signStatement(statement, key.priv);
  else {
    const file = join(work, `msg-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, statement);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", key.priv, "-n", namespace, file], { stdio: "pipe" });
    signature = readFileSync(`${file}.sig`, "utf8");
  }
  const record = buildRecord({ ...fields, identity: ID, signature });
  return { file: recordFileName(record), record };
}
const evaluate = (art, records, opts = options()) => evaluateApproval(art, records, opts);

// ---- Formato ---------------------------------------------------------------------------
test("el texto firmado y el nombre del registro tienen un formato fijo", () => {
  const fields = { action: "approve", slug: "tema-real", sha256: "a".repeat(64), timestamp: "2026-10-21T10:00:00Z" };
  assert.equal(
    statementFor(fields),
    `LegalPrevent blog approval v1\naction: approve\nslug: tema-real\nsha256: ${"a".repeat(64)}\ntimestamp: 2026-10-21T10:00:00Z\nstatement: Autorizo la publicación del contenido identificado por este hash SHA-256.\n`
  );
  assert.match(statementFor({ ...fields, action: "revoke" }), /Revoco la autorización/);
  assert.equal(recordFileName(fields), "20261021T100000Z-approve-aaaaaaaa.json");
  assert.throws(() => statementFor({ ...fields, action: "otra" }), /acción desconocida/);
  assert.equal(nowTimestamp(new Date("2026-10-21T10:00:00.123Z")), "2026-10-21T10:00:00Z");
});

// ---- Aprobación legítima ---------------------------------------------------------------
test("una firma válida del responsable sobre el contenido actual aprueba el artículo", () => {
  const result = evaluate(article(), [signed()]);
  assert.equal(result.ok, true, result.reason);
  assert.match(result.reason, /aprobado por martingrelu/);
});

// ---- 5. Cambiar el estado a approved no basta ------------------------------------------
test("review_status approved sin firma NO aprueba: sin registros falla", () => {
  const result = evaluate(article(), []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no hay ninguna aprobación firmada/);
});

test("un artículo que no está en approved no cuenta, aunque tenga firma", () => {
  assert.match(evaluate(article({ review_status: "in_review" }), [signed()]).reason, /no está aprobado/);
});

test("un registro firmado por otra clave no aprueba", () => {
  const result = evaluate(article(), [signed({ key: keyB })]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /firma inválida/);
});

test("una firma hecha con otro espacio de nombres (p. ej. de git) no vale como aprobación", () => {
  const result = evaluate(article(), [signed({ namespace: "git" })]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /firma inválida/);
});

// ---- 3. Invalidación por cambio de contenido -------------------------------------------
test("si el contenido cambia después de firmar, la aprobación deja de valer", () => {
  const record = signed();
  assert.equal(evaluate(article(), [record]).ok, true);
  assert.match(evaluate(article({}, BODY + " Añadido."), [record]).reason, /hash distinto|sin firmar/);
  assert.match(evaluate(article({ title: "Otro título" }), [record]).reason, /hash distinto|sin firmar/);
  assert.match(evaluate(article({ date_modified: "2026-10-16" }), [record]).reason, /hash distinto|sin firmar/);
  // Cambiar solo los campos de aprobación no altera el hash.
  assert.equal(evaluate(article({ approval: { pr: 1 } }), [record]).ok, true);
});

test("un registro manipulado (campos, firma o nombre) hace fallar la verificación", () => {
  const original = signed();
  const tweak = (patch, file = original.file) => [{ file, record: { ...original.record, ...patch } }];
  assert.match(evaluate(article(), tweak({ timestamp: "2026-10-21T10:00:01Z" })).reason, /nombre del fichero/);
  assert.match(evaluate(article(), tweak({ slug: "otro" })).reason, /slug/);
  assert.match(evaluate(article(), tweak({ identity: "otra-persona" })).reason, /no es de martingrelu/);
  assert.match(evaluate(article(), tweak({ signature: original.record.signature.replace("U1NI", "U1NJ") })).reason, /firma inválida|firma/);
  assert.match(evaluate(article(), tweak({ signature: "nada" })).reason, /falta la firma/);
  assert.match(evaluate(article(), tweak({ action: "revoke" }, recordFileName({ ...original.record, action: "revoke" }))).reason, /firma inválida/);
  assert.match(evaluate(article(), [{ file: "x.json", record: null }]).reason, /JSON no válido/);
});

// ---- Anclaje de confianza fuera del repositorio ----------------------------------------
test("sustituir allowed_signers por otra clave no sirve: la huella fijada no coincide", () => {
  const atacante = signed({ key: keyB });
  const result = evaluate(article(), [atacante], options(keyB, { pinnedFingerprint: keyA.fp }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no coincide con la fijada/);
});

test("sin huella fijada (variable no definida) o con formato inválido, falla cerrado", () => {
  for (const pinnedFingerprint of [undefined, "", "SHA256:corta", "MD5:abc"]) {
    const result = evaluate(article(), [signed()], options(keyA, { pinnedFingerprint }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /falta la huella fijada/);
  }
});

test("allowed_signers debe tener exactamente una clave y ser del responsable", () => {
  assert.match(checkAllowedSigners(keyA.allowed + keyB.allowed, { identity: ID, pinnedFingerprint: keyA.fp }).reason, /exactamente una clave/);
  assert.match(checkAllowedSigners("", { identity: ID, pinnedFingerprint: keyA.fp }).reason, /exactamente una clave/);
  assert.match(checkAllowedSigners(keyA.allowed.replace(ID, "otra"), { identity: ID, pinnedFingerprint: keyA.fp }).reason, /no es de martingrelu/);
  assert.match(checkAllowedSigners(`${ID} no-es-una-clave\n`, { identity: ID, pinnedFingerprint: keyA.fp }).reason, /clave pública válida/);
  assert.equal(checkAllowedSigners(keyA.allowed, { identity: ID, pinnedFingerprint: keyA.fp }).ok, true);
  assert.equal(allowedSignersFingerprint(keyA.allowed, ID).fingerprint, keyA.fp);
});

// ---- 3. Revocación y reaprobación -----------------------------------------------------
test("una revocación posterior invalida la aprobación y una nueva aprobación la restablece", () => {
  const art = article();
  const approve = signed({ timestamp: "2026-10-21T10:00:00Z" });
  const revoke = signed({ action: "revoke", timestamp: "2026-10-21T11:00:00Z" });
  const again = signed({ timestamp: "2026-10-21T11:30:00Z" });
  assert.equal(evaluate(art, [approve]).ok, true);
  assert.match(evaluate(art, [approve, revoke]).reason, /revocada/);
  assert.equal(evaluate(art, [again, revoke, approve]).ok, true, "el orden de los ficheros no importa");
});

test("con el mismo instante, la revocación prevalece", () => {
  const instante = "2026-10-21T10:00:00Z";
  const result = evaluate(article(), [signed({ timestamp: instante }), signed({ action: "revoke", timestamp: instante })]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /revocada/);
});

test("una revocación de otro contenido no afecta al actual", () => {
  const otro = signed({ action: "revoke", sha256: "f".repeat(64), timestamp: "2026-10-21T11:00:00Z" });
  assert.equal(evaluate(article(), [signed(), otro]).ok, true);
});

// ---- Fechas ----------------------------------------------------------------------------
test("una firma con timestamp futuro o con fecha distinta de approved_at falla", () => {
  assert.match(evaluate(article(), [signed({ timestamp: "2026-10-21T12:30:00Z" })]).reason, /timestamp futuro/);
  assert.equal(evaluate(article(), [signed({ timestamp: "2026-10-21T12:04:00Z" })]).ok, true, "tolera 5 minutos de desfase de reloj");
  assert.match(evaluate(article({ approved_at: "2026-10-20" }), [signed()]).reason, /approved_at \(2026-10-20\) no coincide/);
});

// ---- 4. Historial auditable y registros inmutables -------------------------------------
test("createRecord firma, verifica antes de escribir y no sobrescribe registros", () => {
  const root = join(work, "repo-create");
  mkdirSync(join(root, "seo-engine"), { recursive: true });
  writeFileSync(join(root, "seo-engine/allowed_signers"), keyA.allowed);
  const art = article();
  const params = { root, slug: art.meta.slug, action: "approve", sha256: contentHash(art.meta, art.body), identity: ID, now: new Date("2026-10-21T10:00:00Z") };

  const { path, record } = createRecord({ ...params, sign: (s) => signStatement(s, keyA.priv) });
  assert.ok(existsSync(path));
  assert.match(path, /content\/blog\/approvals\/tema-real\/20261021T100000Z-approve-[0-9a-f]{8}\.json$/);
  assert.equal(evaluate(art, loadRecords(join(root, "content/blog/approvals"), "tema-real")).ok, true);
  assert.equal(record.identity, ID);

  // Repetir en el mismo instante ya no llega a firmar: el orden sería ambiguo.
  let firmas = 0;
  const contar = (s) => (firmas++, signStatement(s, keyA.priv));
  assert.throws(() => createRecord({ ...params, sign: contar }), /no es posterior a la del último registro/);
  assert.equal(firmas, 0, "no se firma (ni se pide la contraseña) si el orden sería ambiguo");
  assert.throws(
    () => createRecord({ ...params, now: new Date("2026-10-21T10:05:00Z"), sign: (s) => signStatement(s, keyB.priv) }),
    /la firma generada no valida/
  );
  assert.equal(loadRecords(join(root, "content/blog/approvals"), "tema-real").length, 1, "una firma inválida no deja ningún fichero");
});

// ---- Orden inequívoco entre aprobación, revocación y restauración -----------------------
function newRoot(name) {
  const root = join(work, name);
  mkdirSync(join(root, "seo-engine"), { recursive: true });
  writeFileSync(join(root, "seo-engine/allowed_signers"), keyA.allowed);
  return root;
}
const sha = (art) => contentHash(art.meta, art.body);
const at = (time) => new Date(`2026-10-21T${time}Z`);
const records = (root) => loadRecords(join(root, "content/blog/approvals"), "tema-real");
const sign = (action, root, art, now, spy) =>
  createRecord({ root, slug: art.meta.slug, action, sha256: sha(art), identity: ID, now, sign: (s) => (spy && spy.count++, signStatement(s, keyA.priv)) });

test("aprobación, revocación y restauración con marcas estrictamente crecientes", () => {
  const root = newRoot("repo-order-ok");
  const art = article();
  sign("approve", root, art, at("10:00:00"));
  assert.equal(evaluate(art, records(root)).ok, true, "aprobado");
  sign("revoke", root, art, at("10:30:00"));
  assert.match(evaluate(art, records(root)).reason, /revocada/);
  sign("approve", root, art, at("11:00:00")); // restauración de la autorización
  assert.equal(evaluate(art, records(root)).ok, true, "restaurado");
  assert.equal(records(root).length, 3);
  assert.deepEqual(records(root).map((r) => r.file), records(root).map((r) => r.file).sort(), "el orden de los nombres coincide con el cronológico");
});

test("restaurar el contenido firmado vuelve a aprobarlo; alterarlo lo invalida", () => {
  const root = newRoot("repo-restore");
  const original = article();
  sign("approve", root, original, at("10:00:00"));
  const alterado = article({}, BODY + " Cambio posterior.");
  assert.equal(evaluate(alterado, records(root)).ok, false, "contenido alterado");
  assert.equal(evaluate(original, records(root)).ok, true, "contenido restaurado");
});

test("se rechaza firmar con una marca igual o anterior a la del último registro, sin firmar nada", () => {
  const root = newRoot("repo-order-bad");
  const art = article();
  sign("approve", root, art, at("10:00:00"));
  const spy = { count: 0 };
  for (const [etiqueta, hora] of [["mismo segundo", "10:00:00"], ["reloj atrasado", "09:59:59"], ["reloj muy atrasado", "08:00:00"]]) {
    assert.throws(() => sign("revoke", root, art, at(hora), spy), /no es posterior a la del último registro/, etiqueta);
  }
  assert.equal(spy.count, 0, "nunca se llega a firmar");
  assert.equal(records(root).length, 1, "no se escribe ningún fichero");
  assert.equal(evaluate(art, records(root)).ok, true, "la aprobación sigue intacta");
  sign("revoke", root, art, at("10:00:01"), spy); // un segundo después sí es válido
  assert.match(evaluate(art, records(root)).reason, /revocada/);
});

test("la comparación es con el registro MÁS RECIENTE, no con el primero ni con el más antiguo", () => {
  const root = newRoot("repo-order-latest");
  const art = article();
  sign("approve", root, art, at("10:00:00"));
  sign("revoke", root, art, at("11:00:00"));
  // 10:30 es posterior al primer registro pero anterior al último: debe rechazarse.
  assert.throws(() => sign("approve", root, art, at("10:30:00")), /posterior a la del último registro \(2026-10-21T11:00:00Z/);
  assert.throws(() => sign("approve", root, art, at("11:00:00")), /no es posterior/);
  assert.equal(records(root).length, 2);
  sign("approve", root, art, at("11:00:01"));
  assert.equal(evaluate(art, records(root)).ok, true);
});

test("el orden estricto vale para todo el artículo, también con otro contenido", () => {
  const root = newRoot("repo-order-other-hash");
  const v1 = article();
  const v2 = article({}, BODY + " v2");
  sign("approve", root, v1, at("10:00:00"));
  assert.throws(() => sign("approve", root, v2, at("09:00:00")), /no es posterior/);
  sign("approve", root, v2, at("10:00:01"));
  assert.equal(evaluate(v2, records(root)).ok, true);
});

test("un registro existente ilegible o sin marca válida bloquea la firma", () => {
  const root = newRoot("repo-order-corrupt");
  const art = article();
  const dir = join(root, "content/blog/approvals/tema-real");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roto.json"), "{no es json");
  assert.throws(() => sign("approve", root, art, at("10:00:00")), /no es legible/);
  writeFileSync(join(dir, "roto.json"), JSON.stringify({ timestamp: "ayer" }));
  assert.throws(() => sign("approve", root, art, at("10:00:00")), /marca de tiempo válida/);
  assert.throws(() => assertTimestampAfterLastRecord(root, "tema-real", "2026-10-21T10:00:00Z"), /marca de tiempo válida/);
  assert.doesNotThrow(() => assertTimestampAfterLastRecord(root, "otro-articulo", "2026-10-21T10:00:00Z"), "otros artículos no se ven afectados");
});

test("approve.mjs exige una terminal interactiva y no se ejecuta en CI", () => {
  assert.throws(() => assertInteractive({ isTTY: false, env: {} }), /terminal interactiva/);
  assert.throws(() => assertInteractive({ isTTY: true, env: { CI: "true" } }), /CI/);
  assert.throws(() => assertInteractive({ isTTY: true, env: { GITHUB_ACTIONS: "true" } }), /CI/);
  assert.doesNotThrow(() => assertInteractive({ isTTY: true, env: {} }));
  const run = spawnSync("node", ["seo-engine/approve.mjs", "tema-real"], {
    cwd: new URL("..", import.meta.url).pathname,
    input: "",
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /terminal interactiva/);
});

// ---- Verificación del repositorio completo ---------------------------------------------
function repo(name, { articles = [], records = [], allowed = keyA.allowed } = {}) {
  const root = join(work, name);
  mkdirSync(join(root, "seo-engine"), { recursive: true });
  mkdirSync(join(root, "content/blog"), { recursive: true });
  if (allowed !== null) writeFileSync(join(root, "seo-engine/allowed_signers"), allowed);
  for (const { meta, body } of articles) writeFileSync(join(root, "content/blog", `${meta.slug}.md`), `---\n${JSON.stringify(meta)}\n---\n${body}`);
  for (const { slug, file, record } of records) {
    mkdirSync(join(root, "content/blog/approvals", slug), { recursive: true });
    writeFileSync(join(root, "content/blog/approvals", slug, file), JSON.stringify(record));
  }
  return root;
}
const verifyRepo = (root, extra = {}) => verifySignedApprovals({ root, identity: ID, pinnedFingerprint: keyA.fp, now: NOW, ...extra });

test("verifySignedApprovals: firmado pasa; solo approved sin firma, sin allowed_signers o fixture falla", () => {
  const art = article();
  const good = signed({ art });
  assert.deepEqual(verifyRepo(repo("r-ok", { articles: [art], records: [{ slug: "tema-real", ...good }] })).map((r) => r.ok), [true]);

  const sinFirma = verifyRepo(repo("r-unsigned", { articles: [art] }));
  assert.equal(sinFirma[0].ok, false);
  assert.match(sinFirma[0].reason, /no hay ninguna aprobación firmada/);

  assert.match(verifyRepo(repo("r-nosigners", { articles: [art], allowed: null }))[0].reason, /falta seo-engine\/allowed_signers/);
  assert.equal(verifyRepo(repo("r-nopin", { articles: [art], records: [{ slug: "tema-real", ...good }] }), { pinnedFingerprint: undefined })[0].ok, false);

  const fixture = article({ slug: "ficticio", fixture: true });
  const resultado = verifyRepo(repo("r-fixture", { articles: [fixture], records: [{ slug: "ficticio", ...signed({ art: fixture }) }] }));
  assert.equal(resultado[0].ok, false);
  assert.match(resultado[0].reason, /fixture/);
});

test("verifySignedApprovals: los borradores no necesitan firma y los cambios posteriores la invalidan", () => {
  const borrador = article({ slug: "borrador", review_status: "in_review", approved_at: undefined });
  delete borrador.meta.approved_at;
  assert.deepEqual(verifyRepo(repo("r-draft", { articles: [borrador] })), []);

  const art = article();
  const good = signed({ art });
  const cambiado = article({}, BODY + " Cambio tras la firma.");
  const res = verifyRepo(repo("r-changed", { articles: [cambiado], records: [{ slug: "tema-real", ...good }] }));
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason, /hash distinto|sin firmar/);
});
