// Excepciones FIRMADAS para fuentes AEPD/INSST temporalmente inaccesibles (F2.3c).
//
// Una excepción NO aprueba nada ni verifica nada: documenta que el responsable ha visto que la fuente no responde y asume,
// durante poco tiempo, comprobarla a mano. El resultado es `REVISION_EXCEPCIONAL`, nunca `verified`, y no sustituye a la
// firma de aprobación del artículo (espacio de nombres y registros distintos).
//
// Reglas (todas se comprueban aquí y cada una tiene su prueba adversa):
//   - Solo AEPD/INSST y solo ante `unreachable` (la fuente no respondió). Nunca el BOE.
//   - Nunca si hay evidencia de modificación, contradicción o cita incorrecta (cualquier fallo offline de la cita).
//   - Firma SSH independiente (espacio de nombres propio) con la misma clave fijada del responsable.
//   - Vinculada criptográficamente a: slug, contenido del artículo, cita, fuente (entrada del registro) y candado.
//   - Caduca a los 7 días como máximo y nunca después de que el candado cumpla 7 días.
//   - Un registro posterior (grant/revoke) prevalece; ante empate, la revocación.
//   - Cualquier registro ilegible, mal firmado o incoherente deniega la excepción (falla cerrado).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkAllowedSigners } from "../approval-signature.mjs";
import { contentHash } from "../blog-render.mjs";
import { lockProblems, registryEntryHash } from "./schema.mjs";
import { canonicalJson, sha256Hex } from "./text.mjs";

export const EXCEPTION_NAMESPACE = "legalprevent-source-exception";
export const EXCEPTION_STATE = "REVISION_EXCEPCIONAL";
export const MAX_EXCEPTION_DAYS = 7;
export const MAX_LOCK_AGE_DAYS = 7;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const EXCEPTIONABLE_AUTHORITIES = ["AEPD", "INSST"];
export const EXCEPTION_REASON = "fuente_inalcanzable";
const DAY = 86_400_000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS = ["grant", "revoke"];
const KEY_TYPES = /^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const BINDING_KEYS = ["slug", "content_sha256", "citation", "source", "authority", "source_sha256", "lock_sha256", "lock_verified_at", "quote_sha256"];

export const nowTimestamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
export const lockHash = (lock) => sha256Hex(canonicalJson(lock));
export const bindingId = (binding) => sha256Hex(canonicalJson(binding));

// Lo que firma el responsable: todo lo que identifica a ESTA cita en ESTE contenido con ESTE candado.
export function bindingFor({ meta, body, citation, entry }) {
  return {
    slug: meta.slug,
    content_sha256: contentHash(meta, body),
    citation: citation.id,
    source: entry.id,
    authority: entry.authority,
    source_sha256: registryEntryHash(entry),
    lock_sha256: lockHash(citation.lock),
    lock_verified_at: citation.lock.verified_at,
    quote_sha256: citation.lock.quote_sha256 ?? null,
  };
}

// Fecha límite impuesta por el candado: verified_at + 7 días (inclusive).
export const lockCutoff = (lock) => Date.parse(`${lock.verified_at}T00:00:00Z`) + MAX_LOCK_AGE_DAYS * DAY;

export function statementFor({ action, binding, issued_at, expires_at }) {
  if (!ACTIONS.includes(action)) throw new Error(`acción desconocida: ${action}`);
  return [
    "LegalPrevent source exception v1",
    `action: ${action}`,
    ...BINDING_KEYS.map((key) => `${key}: ${binding[key]}`),
    `binding: ${bindingId(binding)}`,
    `reason: ${EXCEPTION_REASON}`,
    `issued_at: ${issued_at}`,
    `expires_at: ${action === "grant" ? expires_at : "-"}`,
    `statement: ${action === "grant" ? "Autorizo, hasta la fecha indicada, que esta cita de una fuente temporalmente inaccesible quede en revisión excepcional; no la verifica ni aprueba el artículo." : "Revoco la excepción para esta cita."}`,
    "",
  ].join("\n");
}

export const recordFileName = ({ action, binding, issued_at }) => `${issued_at.replace(/[-:]/g, "")}-${action}-${bindingId(binding).slice(0, 8)}.json`;

// ---- Elegibilidad (sin firma): ¿podría concederse una excepción para esta cita? -------------------------
export function eligibility({ citation, entry, offlineItem, now = new Date() }) {
  const reasons = [];
  if (!entry) return { ok: false, reasons: ["fuente_desconocida"] };
  if (entry.authority === "BOE") reasons.push("boe_no_excepcionable");
  else if (!EXCEPTIONABLE_AUTHORITIES.includes(entry.authority)) reasons.push("autoridad_no_excepcionable");
  const lock = citation?.lock;
  if (!lock || lockProblems(lock).length) reasons.push("candado_invalido");
  else {
    if (lock.engine !== "web-v1") reasons.push("candado_no_web");
    if (lock.source_sha256 !== registryEntryHash(entry)) reasons.push("registro_modificado");
    const verified = Date.parse(`${lock.verified_at}T00:00:00Z`);
    if (verified > now.getTime()) reasons.push("candado_futuro");
    if (now.getTime() > lockCutoff(lock)) reasons.push("candado_con_mas_de_7_dias");
  }
  // Evidencia de modificación, contradicción o cita incorrecta: cualquier fallo offline de ESTA cita.
  if (!offlineItem) reasons.push("sin_verificacion_offline");
  else if (offlineItem.failed?.length) reasons.push(...offlineItem.failed.map((r) => `evidencia:${r}`));
  return { ok: reasons.length === 0, reasons };
}

// ---- Firma ------------------------------------------------------------------------------------------
function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "lp-exception-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function signStatement(statement, keyPath, { interactive = false } = {}) {
  return withTempDir((dir) => {
    const file = join(dir, "statement.txt");
    writeFileSync(file, statement);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", EXCEPTION_NAMESPACE, file], { stdio: interactive ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"] });
    return readFileSync(`${file}.sig`, "utf8");
  });
}

// La clave es la MISMA que ancla las aprobaciones (huella fijada fuera del repositorio); aquí solo se ajusta el espacio de
// nombres permitido para esta verificación. Una firma de aprobación no valida como excepción ni al revés.
function exceptionSigners(allowedSigners, identity) {
  const line = String(allowedSigners).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] ?? "";
  const tokens = line.split(/\s+/);
  const at = tokens.findIndex((token, index) => index > 0 && KEY_TYPES.test(token));
  if (tokens[0] !== identity || at === -1 || !tokens[at + 1]) throw new Error("allowed_signers no contiene la clave del responsable");
  return `${identity} namespaces="${EXCEPTION_NAMESPACE}" ${tokens[at]} ${tokens[at + 1]}\n`;
}

export function verifyRecordSignature(record, { allowedSigners, identity, fingerprint }) {
  try {
    if (record.identity !== identity) return { ok: false, reason: `el registro no es de ${identity}` };
    const statement = statementFor(record);
    const output = withTempDir((dir) => {
      writeFileSync(join(dir, "allowed_signers"), exceptionSigners(allowedSigners, identity));
      writeFileSync(join(dir, "sig"), record.signature);
      return execFileSync("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", identity, "-n", EXCEPTION_NAMESPACE, "-s", join(dir, "sig")], { encoding: "utf8", input: statement, stdio: ["pipe", "pipe", "pipe"] });
    });
    if (output.match(/key (SHA256:\S+)/)?.[1] !== fingerprint) return { ok: false, reason: "la firma no es de la clave fijada" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "firma inválida" };
  }
}

// ---- Forma estricta de un registro ------------------------------------------------------------------------
function recordProblem(record, file) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "registro con formato no válido";
  const keys = ["version", "action", "binding", "issued_at", "identity", "signature", ...(record.action === "grant" ? ["expires_at"] : [])];
  if (Object.keys(record).sort().join() !== [...keys, "reason"].sort().join()) return "campos inesperados o ausentes";
  if (record.version !== 1 || !ACTIONS.includes(record.action)) return "versión o acción no válidas";
  if (record.reason !== EXCEPTION_REASON) return "motivo no válido";
  const binding = record.binding;
  if (!binding || typeof binding !== "object" || Object.keys(binding).sort().join() !== [...BINDING_KEYS].sort().join()) return "vinculación incompleta";
  if (!ID.test(binding.slug) || !ID.test(binding.citation) || !ID.test(binding.source)) return "identificadores no válidos";
  if (!EXCEPTIONABLE_AUTHORITIES.includes(binding.authority)) return "autoridad no excepcionable";
  for (const key of ["content_sha256", "source_sha256", "lock_sha256"]) if (!HEX64.test(binding[key] ?? "")) return `${key} no válido`;
  if (binding.quote_sha256 !== null && !HEX64.test(binding.quote_sha256 ?? "")) return "quote_sha256 no válido";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(binding.lock_verified_at ?? "") || Number.isNaN(Date.parse(binding.lock_verified_at))) return "lock_verified_at no válido";
  if (!TIMESTAMP.test(record.issued_at ?? "") || Number.isNaN(Date.parse(record.issued_at))) return "issued_at no válido";
  if (record.action === "grant" && (!TIMESTAMP.test(record.expires_at ?? "") || Number.isNaN(Date.parse(record.expires_at)))) return "expires_at no válido";
  if (typeof record.signature !== "string" || !record.signature.startsWith("-----BEGIN SSH SIGNATURE-----")) return "falta la firma";
  if (file !== recordFileName(record)) return `el nombre del fichero no coincide con su contenido (esperado ${recordFileName(record)})`;
  return null;
}

export function loadRecords(exceptionsDir, slug) {
  const dir = resolve(exceptionsDir, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((file) => {
    try {
      return { file, record: JSON.parse(readFileSync(resolve(dir, file), "utf8")) };
    } catch {
      return { file, record: null };
    }
  });
}

// ---- Decisión ------------------------------------------------------------------------------------------------
// Devuelve { status: "REVISION_EXCEPCIONAL" | "NO_EXCEPCION", reasons, ... }. Nunca devuelve "verified".
export function evaluateException({ meta, body, citation, entry, offlineItem, records, allowedSigners, identity, pinnedFingerprint, now = new Date() }) {
  const no = (...reasons) => ({ status: "NO_EXCEPCION", reasons });
  const eligible = eligibility({ citation, entry, offlineItem, now });
  if (!eligible.ok) return no(...eligible.reasons);
  const anchor = checkAllowedSigners(allowedSigners, { identity, pinnedFingerprint });
  if (!anchor.ok) return no(`ancla:${anchor.reason}`);

  const id = bindingId(bindingFor({ meta, body, citation, entry }));
  const relevant = [];
  for (const { file, record } of records ?? []) {
    const problem = recordProblem(record, file);
    if (problem) return no(`${file}: ${problem}`); // un registro roto no se ignora: falla cerrado
    if (record.binding.slug !== meta.slug) return no(`${file}: el slug no coincide con su carpeta`);
    if (bindingId(record.binding) !== id) continue; // otra cita, otro contenido, otro candado u otra fuente: no cuenta
    const verified = verifyRecordSignature(record, { allowedSigners, identity, fingerprint: anchor.fingerprint });
    if (!verified.ok) return no(`${file}: ${verified.reason}`);
    if (Date.parse(record.issued_at) > now.getTime() + FUTURE_SKEW_MS) return no(`${file}: issued_at futuro`);
    if (record.action === "grant") {
      const span = Date.parse(record.expires_at) - Date.parse(record.issued_at);
      if (span <= 0) return no(`${file}: expires_at no es posterior a issued_at`);
      if (span > MAX_EXCEPTION_DAYS * DAY) return no(`${file}: la excepción dura más de ${MAX_EXCEPTION_DAYS} días`);
      if (Date.parse(record.issued_at) < Date.parse(`${citation.lock.verified_at}T00:00:00Z`)) return no(`${file}: emitida antes del candado`);
    }
    relevant.push(record);
  }
  if (!relevant.length) return no("sin_excepcion_firmada_para_esta_cita");

  relevant.sort((a, b) => b.issued_at.localeCompare(a.issued_at) || (a.action === "revoke" ? -1 : 1) - (b.action === "revoke" ? -1 : 1));
  const latest = relevant[0];
  if (latest.action !== "grant") return no(`excepción revocada el ${latest.issued_at}`);
  const expiry = Math.min(Date.parse(latest.expires_at), lockCutoff(citation.lock));
  if (now.getTime() >= expiry) return no(`excepción caducada (${new Date(expiry).toISOString()})`);
  return { status: EXCEPTION_STATE, reasons: [], record: latest, issued_at: latest.issued_at, expires_at: new Date(expiry).toISOString().replace(/\.\d{3}Z$/, "Z") };
}

// ---- Creación (la usa la herramienta local; `sign` se inyecta para las pruebas con claves efímeras) -----------
export function createExceptionRecord({ root, action, binding, identity, sign, now = new Date(), cutoff }) {
  const issued_at = nowTimestamp(now);
  let expires_at;
  if (action === "grant") {
    const until = Math.min(now.getTime() + MAX_EXCEPTION_DAYS * DAY, cutoff);
    if (!(until > now.getTime())) throw new Error("el candado ya tiene más de 7 días: hay que recalcularlo antes de conceder una excepción");
    expires_at = nowTimestamp(new Date(until));
  }
  const record = { version: 1, action, binding, issued_at, ...(action === "grant" ? { expires_at } : {}), reason: EXCEPTION_REASON, identity, signature: sign(statementFor({ action, binding, issued_at, expires_at })) };
  const allowedSigners = readFileSync(resolve(root, "seo-engine/allowed_signers"), "utf8");
  const verified = verifyRecordSignature(record, { allowedSigners, identity, fingerprint: pinnedOrOwn(allowedSigners, identity) });
  if (!verified.ok) throw new Error(`la firma generada no valida contra seo-engine/allowed_signers: ${verified.reason}`);
  const path = resolve(root, "content/blog/exceptions", binding.slug, recordFileName(record));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return { path, record };
}

function pinnedOrOwn(allowedSigners, identity) {
  const found = checkAllowedSigners(allowedSigners, { identity, pinnedFingerprint: ownFingerprint(allowedSigners, identity) });
  if (!found.ok) throw new Error(found.reason);
  return found.fingerprint;
}
function ownFingerprint(allowedSigners, identity) {
  const line = String(allowedSigners).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] ?? "";
  const tokens = line.split(/\s+/);
  const at = tokens.findIndex((token, index) => index > 0 && KEY_TYPES.test(token));
  if (tokens[0] !== identity || at === -1) throw new Error("allowed_signers no contiene la clave del responsable");
  return withTempDir((dir) => {
    writeFileSync(join(dir, "k.pub"), `${tokens[at]} ${tokens[at + 1]}\n`);
    return execFileSync("ssh-keygen", ["-l", "-f", join(dir, "k.pub")], { encoding: "utf8" }).match(/(SHA256:[A-Za-z0-9+/]{43})/)[1];
  });
}
