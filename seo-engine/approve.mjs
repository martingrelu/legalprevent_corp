// Herramienta LOCAL del responsable jurídico: firma la autorización de publicación (o su revocación).
// Debe ejecutarse en una terminal interactiva propia: pide confirmar el hash y la contraseña de la clave.
// No se ejecuta en CI ni sin terminal, para que un proceso automático no pueda firmar por su cuenta.
//
// Uso:
//   node seo-engine/approve.mjs <slug> [--key ~/.ssh/legalprevent_approval]
//   node seo-engine/approve.mjs <slug> --revoke [--sha256 <hash>] [--key …]
//
// Antes de firmar, el artículo debe tener review_status "approved" y approved_at = hoy (UTC).
// Escribe content/blog/approvals/<slug>/<fecha>-<acción>-<hash8>.json; después hay que commitearlo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { contentHash, parseSource } from "./blog-render.mjs";
import {
  allowedSignersFingerprint,
  buildRecord,
  nowTimestamp,
  recordFileName,
  signStatement,
  statementFor,
  verifyRecordSignature,
} from "./approval-signature.mjs";

// Crea y comprueba el registro. `sign` se inyecta para poder probarlo con claves efímeras.
export function createRecord({ root, slug, action, sha256, identity, sign, now = new Date() }) {
  const timestamp = nowTimestamp(now);
  const statement = statementFor({ action, slug, sha256, timestamp });
  const record = buildRecord({ action, slug, sha256, timestamp, identity, signature: sign(statement) });
  const allowedSigners = readFileSync(resolve(root, "seo-engine/allowed_signers"), "utf8");
  const found = allowedSignersFingerprint(allowedSigners, identity);
  if (!found.ok) throw new Error(found.reason);
  const verified = verifyRecordSignature(record, { allowedSigners, identity, fingerprint: found.fingerprint });
  if (!verified.ok) throw new Error(`la firma generada no valida contra seo-engine/allowed_signers: ${verified.reason}`);
  const path = resolve(root, "content/blog/approvals", slug, recordFileName(record));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return { path, record };
}

export function assertInteractive({ isTTY = process.stdin.isTTY && process.stdout.isTTY, env = process.env } = {}) {
  if (env.CI || env.GITHUB_ACTIONS) throw new Error("approve.mjs no se puede ejecutar en CI");
  if (!isTTY) throw new Error("approve.mjs necesita una terminal interactiva (la firma debe ser un acto deliberado del responsable)");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    assertInteractive();
    const args = process.argv.slice(2);
    const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const slug = args[0]?.startsWith("--") ? undefined : args[0];
    if (!slug) throw new Error("uso: node seo-engine/approve.mjs <slug> [--revoke] [--sha256 <hash>] [--key <ruta>]");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { reviewer_github: identity, reviewer_name: name } = JSON.parse(readFileSync(resolve(root, "seo-engine/approvers.json"), "utf8"));
    const keyPath = resolve(option("--key") ?? `${homedir()}/.ssh/legalprevent_approval`);
    const action = args.includes("--revoke") ? "revoke" : "approve";

    const { meta, body } = parseSource(readFileSync(resolve(root, "content/blog", `${slug}.md`), "utf8"), `${slug}.md`);
    const sha256 = option("--sha256") ?? contentHash(meta, body);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("--sha256 debe ser un SHA-256 en hexadecimal");
    if (action === "approve") {
      if (meta.review_status !== "approved") throw new Error('el artículo debe tener review_status "approved" antes de firmar');
      const today = nowTimestamp().slice(0, 10);
      if (meta.approved_at !== today) throw new Error(`approved_at debe ser la fecha de hoy (${today}) y es ${meta.approved_at}`);
    }

    console.log(`\n${action === "approve" ? "AUTORIZACIÓN DE PUBLICACIÓN" : "REVOCACIÓN"} — ${name} (${identity})`);
    console.log(`  Título:  ${meta.title}\n  Slug:    ${slug}\n  SHA-256: ${sha256}\n  Fuentes: ${(meta.sources ?? []).length}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`Escribe los 8 primeros caracteres del hash (${sha256.slice(0, 8)}) para confirmar: `)).trim();
    rl.close();
    if (typed !== sha256.slice(0, 8)) throw new Error("confirmación incorrecta; no se ha firmado nada");

    const { path } = createRecord({ root, slug, action, sha256, identity, sign: (statement) => signStatement(statement, keyPath, { interactive: true }) });
    console.log(`\nRegistro firmado y verificado: ${path}\nAhora commitéalo (git add content/blog/approvals/${slug}).`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
