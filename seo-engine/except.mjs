// Herramienta LOCAL del responsable jurídico: firma (o revoca) una EXCEPCIÓN para una cita de una fuente AEPD/INSST que
// no responde. Misma regla que approve.mjs: terminal interactiva propia, confirmación del hash y contraseña de la clave;
// no se ejecuta en CI ni sin terminal. La excepción NO aprueba el artículo ni verifica la fuente (ver sources/exceptions.mjs).
//
// Uso:
//   node seo-engine/except.mjs <slug> <id-de-cita> [--key ~/.ssh/legalprevent_approval]
//   node seo-engine/except.mjs <slug> <id-de-cita> --revoke [--key …]
//
// Escribe content/blog/exceptions/<slug>/<fecha>-<grant|revoke>-<hash8>.json; después hay que commitearlo.
// No modifica el artículo ni sus aprobaciones.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseSource } from "./blog-render.mjs";
import { bindingFor, bindingId, createExceptionRecord, eligibility, loadRecords, lockCutoff, signStatement } from "./sources/exceptions.mjs";
import { loadRegistry, verifyArticleCitations } from "./sources/verify-citations.mjs";

export function assertInteractive({ isTTY = process.stdin.isTTY && process.stdout.isTTY, env = process.env } = {}) {
  if (env.CI || env.GITHUB_ACTIONS) throw new Error("except.mjs no se puede ejecutar en CI");
  if (!isTTY) throw new Error("except.mjs necesita una terminal interactiva (la firma debe ser un acto deliberado del responsable)");
}

// Prepara la vinculación y comprueba la elegibilidad. Se separa de la CLI para poder probarla.
export function prepare({ root, slug, citationId, action, now = new Date() }) {
  const { meta, body } = parseSource(readFileSync(resolve(root, "content/blog", `${slug}.md`), "utf8"), `${slug}.md`);
  const registry = loadRegistry(resolve(root, "content/sources/registry.json"));
  const citation = (meta.citations ?? []).find((c) => c.id === citationId);
  if (!citation) throw new Error(`el artículo ${slug} no tiene la cita ${citationId}`);
  const entry = registry.sources.find((e) => e.id === citation.source);
  if (action === "grant") {
    const offlineItem = verifyArticleCitations({ meta, body }, registry, { now }).items.find((i) => i.citation === citationId);
    const eligible = eligibility({ citation, entry, offlineItem, now });
    if (!eligible.ok) throw new Error(`no se puede conceder una excepción: ${eligible.reasons.join(", ")}`);
    return { meta, binding: bindingFor({ meta, body, citation, entry }), cutoff: lockCutoff(citation.lock), entry, citation };
  }
  // Revocar: se revoca la última concesión de esa cita (aunque el contenido haya cambiado desde entonces).
  const grants = loadRecords(resolve(root, "content/blog/exceptions"), slug).map((r) => r.record).filter((r) => r?.action === "grant" && r.binding?.citation === citationId);
  if (!grants.length) throw new Error("no hay ninguna excepción concedida para esa cita");
  grants.sort((a, b) => b.issued_at.localeCompare(a.issued_at));
  return { meta, binding: grants[0].binding, entry, citation };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    assertInteractive();
    const args = process.argv.slice(2);
    const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const [slug, citationId] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--key");
    if (!slug || !citationId) throw new Error("uso: node seo-engine/except.mjs <slug> <id-de-cita> [--revoke] [--key <ruta>]");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { reviewer_github: identity, reviewer_name: name } = JSON.parse(readFileSync(resolve(root, "seo-engine/approvers.json"), "utf8"));
    const keyPath = resolve(option("--key") ?? `${homedir()}/.ssh/legalprevent_approval`);
    const action = args.includes("--revoke") ? "revoke" : "grant";
    const { binding, cutoff, entry } = prepare({ root, slug, citationId, action });
    const id = bindingId(binding);

    console.log(`\n${action === "grant" ? "EXCEPCIÓN POR FUENTE INACCESIBLE" : "REVOCACIÓN DE EXCEPCIÓN"} — ${name} (${identity})`);
    console.log(`  Artículo: ${slug}   Cita: ${citationId}   Fuente: ${binding.source} (${entry?.authority ?? binding.authority})`);
    console.log(`  Contenido: ${binding.content_sha256}\n  Candado:   ${binding.lock_sha256} (verificado el ${binding.lock_verified_at})\n  Vinculación: ${id}`);
    if (action === "grant") console.log("  Esto NO verifica la fuente ni aprueba el artículo: queda como REVISION_EXCEPCIONAL hasta 7 días (y nunca más allá de que el candado cumpla 7).");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`Escribe los 8 primeros caracteres de la vinculación (${id.slice(0, 8)}) para confirmar: `)).trim();
    rl.close();
    if (typed !== id.slice(0, 8)) throw new Error("confirmación incorrecta; no se ha firmado nada");

    const { path } = createExceptionRecord({ root, action, binding, identity, cutoff, sign: (statement) => signStatement(statement, keyPath, { interactive: true }) });
    console.log(`\nRegistro firmado y verificado: ${path}\nAhora commitéalo (git add content/blog/exceptions/${slug}).`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
