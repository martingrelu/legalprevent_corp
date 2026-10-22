// Aprobación individual por firma SSH desprendida (alternativa A).
//
// El responsable firma en su propia terminal, con una clave dedicada, un texto fijo que contiene
// el slug y el SHA-256 del contenido revisado. La firma usa el espacio de nombres
// "legalprevent-blog-approval", de modo que una firma de commit o de otro uso NO vale como aprobación.
// La verificación es offline (ssh-keygen -Y verify): no usa red, tokens ni la API de GitHub.
//
// Anclaje de confianza: la clave pública está en seo-engine/allowed_signers, pero su huella debe coincidir
// con la fijada FUERA del repositorio (variable de Actions BLOG_APPROVER_FINGERPRINT). Quien solo pueda
// hacer push no puede cambiar esa variable ni, por tanto, sustituir la clave.
//
// Un artículo cuenta como aprobado solo si, para el hash SHA-256 de su contenido ACTUAL, el registro
// firmado más reciente es una aprobación válida (y no una revocación). El campo review_status por sí
// solo no aprueba nada.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentHash, loadArticles } from "./blog-render.mjs";

export const NAMESPACE = "legalprevent-blog-approval";
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
const ACTIONS = { approve: "Autorizo la publicación del contenido identificado por este hash SHA-256.", revoke: "Revoco la autorización de publicación del contenido identificado por este hash SHA-256." };
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KEY_TYPES = /^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

// ---- Texto firmado y registros --------------------------------------------------------
export function statementFor({ action, slug, sha256, timestamp }) {
  if (!(action in ACTIONS)) throw new Error(`acción desconocida: ${action}`);
  return [
    "LegalPrevent blog approval v1",
    `action: ${action}`,
    `slug: ${slug}`,
    `sha256: ${sha256}`,
    `timestamp: ${timestamp}`,
    `statement: ${ACTIONS[action]}`,
    "",
  ].join("\n");
}

export const recordFileName = ({ action, sha256, timestamp }) =>
  `${timestamp.replace(/[-:]/g, "")}-${action}-${sha256.slice(0, 8)}.json`;

export const nowTimestamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "lp-approval-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ssh = (args, options = {}) => execFileSync("ssh-keygen", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });

// Firma `statement` con la clave privada `keyPath` (puede pedir la contraseña en el terminal).
export function signStatement(statement, keyPath, { interactive = false } = {}) {
  return withTempDir((dir) => {
    const file = join(dir, "statement.txt");
    writeFileSync(file, statement);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", NAMESPACE, file], {
      stdio: interactive ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
    });
    return readFileSync(`${file}.sig`, "utf8");
  });
}

export function buildRecord({ action, slug, sha256, timestamp, identity, signature }) {
  return { version: 1, action, slug, sha256, timestamp, identity, signature };
}

// ---- Anclaje de confianza --------------------------------------------------------------
// Devuelve { ok, reason, fingerprint }. Exige una única clave, del responsable, con la huella fijada.
export function checkAllowedSigners(allowedSigners, { identity, pinnedFingerprint }) {
  if (!FINGERPRINT.test(pinnedFingerprint ?? "")) {
    return { ok: false, reason: "falta la huella fijada (variable BLOG_APPROVER_FINGERPRINT) o no tiene formato SHA256:…" };
  }
  const found = allowedSignersFingerprint(allowedSigners, identity);
  if (!found.ok) return found;
  if (found.fingerprint !== pinnedFingerprint) {
    return { ok: false, reason: "la huella de allowed_signers no coincide con la fijada fuera del repositorio" };
  }
  return found;
}

// Huella de la única clave de allowed_signers (sin compararla con ninguna fijada).
export function allowedSignersFingerprint(allowedSigners, identity) {
  const lines = String(allowedSigners ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length !== 1) return { ok: false, reason: "allowed_signers debe contener exactamente una clave" };
  const tokens = lines[0].split(/\s+/);
  if (tokens[0] !== identity) return { ok: false, reason: `allowed_signers no es de ${identity}` };
  const at = tokens.findIndex((token, index) => index > 0 && KEY_TYPES.test(token));
  if (at === -1 || !tokens[at + 1]) return { ok: false, reason: "allowed_signers no contiene una clave pública válida" };
  let output;
  try {
    output = withTempDir((dir) => {
      const file = join(dir, "key.pub");
      writeFileSync(file, `${tokens[at]} ${tokens[at + 1]}\n`);
      return ssh(["-l", "-f", file]);
    });
  } catch (error) {
    return { ok: false, reason: `no se pudo leer la clave pública: ${error.message.split("\n")[0]}` };
  }
  const fingerprint = output.match(/(SHA256:[A-Za-z0-9+/]{43})/)?.[1];
  return fingerprint ? { ok: true, fingerprint } : { ok: false, reason: "no se pudo calcular la huella de la clave" };
}

// ---- Verificación de un registro -------------------------------------------------------
export function verifyRecordSignature(record, { allowedSigners, identity, fingerprint }) {
  try {
    if (record.identity !== identity) return { ok: false, reason: `el registro no es de ${identity}` };
    const statement = statementFor(record);
    const output = withTempDir((dir) => {
      writeFileSync(join(dir, "allowed_signers"), allowedSigners);
      writeFileSync(join(dir, "sig"), record.signature);
      return ssh(["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", identity, "-n", NAMESPACE, "-s", join(dir, "sig")], { input: statement });
    });
    const signedWith = output.match(/key (SHA256:\S+)/)?.[1];
    if (signedWith !== fingerprint) return { ok: false, reason: "la firma no es de la clave fijada" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "firma inválida" };
  }
}

function recordProblem(record, file, slug) {
  if (record?.version !== 1 || !(record.action in ACTIONS)) return "registro con formato no válido";
  if (record.slug !== slug) return "el slug del registro no coincide con su carpeta";
  if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) return "sha256 no válido";
  if (!TIMESTAMP.test(record.timestamp ?? "") || Number.isNaN(Date.parse(record.timestamp))) return "timestamp no válido";
  if (typeof record.signature !== "string" || !record.signature.startsWith("-----BEGIN SSH SIGNATURE-----")) return "falta la firma";
  if (file !== recordFileName(record)) return `el nombre del fichero no coincide con su contenido (esperado ${recordFileName(record)})`;
  return null;
}

export function loadRecords(approvalsDir, slug) {
  const dir = resolve(approvalsDir, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        return { file, record: JSON.parse(readFileSync(resolve(dir, file), "utf8")) };
      } catch {
        return { file, record: null };
      }
    });
}

// ---- Decisión: ¿está aprobado el contenido ACTUAL? -------------------------------------
export function evaluateApproval({ meta, body }, records, { allowedSigners, identity, pinnedFingerprint, now = new Date() }) {
  const fail = (reason) => ({ ok: false, reason });
  if (meta.fixture === true) return fail("un artículo de pruebas (fixture) no puede estar en content/blog");
  if (meta.review_status !== "approved") return fail("el artículo no está aprobado");
  const anchor = checkAllowedSigners(allowedSigners, { identity, pinnedFingerprint });
  if (!anchor.ok) return fail(anchor.reason);
  const sha256 = contentHash(meta, body);

  const relevant = [];
  for (const { file, record } of records) {
    if (!record || record.sha256 !== sha256) {
      if (!record) return fail(`${file}: JSON no válido`);
      continue; // registros de otras versiones del contenido: no cuentan
    }
    const problem = recordProblem(record, file, meta.slug);
    if (problem) return fail(`${file}: ${problem}`);
    const verified = verifyRecordSignature(record, { allowedSigners, identity, fingerprint: anchor.fingerprint });
    if (!verified.ok) return fail(`${file}: ${verified.reason}`);
    if (Date.parse(record.timestamp) > now.getTime() + FUTURE_SKEW_MS) return fail(`${file}: timestamp futuro`);
    relevant.push(record);
  }
  if (!relevant.length) return fail("no hay ninguna aprobación firmada para el contenido actual (hash distinto o sin firmar)");

  // Más reciente primero; ante empate, la revocación prevalece.
  relevant.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || (a.action === "revoke" ? -1 : 1) - (b.action === "revoke" ? -1 : 1));
  const latest = relevant[0];
  if (latest.action !== "approve") return fail(`la autorización fue revocada el ${latest.timestamp}`);
  if (latest.timestamp.slice(0, 10) !== meta.approved_at) {
    return fail(`approved_at (${meta.approved_at}) no coincide con la fecha de la firma (${latest.timestamp.slice(0, 10)})`);
  }
  return { ok: true, reason: `aprobado por ${identity} el ${latest.timestamp} (sha256 ${sha256.slice(0, 8)}…)`, record: latest };
}

// ---- Verificación de todo el repositorio ----------------------------------------------
export function verifySignedApprovals({ root, identity, pinnedFingerprint, now = new Date() }) {
  const articles = loadArticles(resolve(root, "content/blog")).filter(({ meta }) => meta.review_status === "approved");
  const signersFile = resolve(root, "seo-engine/allowed_signers");
  const allowedSigners = existsSync(signersFile) ? readFileSync(signersFile, "utf8") : "";
  return articles.map((article) => {
    const records = loadRecords(resolve(root, "content/blog/approvals"), article.meta.slug);
    const result = allowedSigners
      ? evaluateApproval(article, records, { allowedSigners, identity, pinnedFingerprint, now })
      : { ok: false, reason: "falta seo-engine/allowed_signers" };
    return { slug: article.meta.slug, ...result };
  });
}
