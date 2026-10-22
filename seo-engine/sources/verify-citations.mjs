// Verificación OFFLINE de las citas de un artículo contra el registro de fuentes y sus candados.
// Sin red. Es determinista: la misma entrada da siempre el mismo resultado.
//
// Estados por cita: verified | needs_review | failed. Una cita NUNCA es válida solo por existir:
//  - failed bloquea;
//  - needs_review bloquea hasta que el responsable la reconozca por escrito (review_ack), y ese reconocimiento
//    forma parte del contenido que se firma;
//  - verified solo significa "coherente con su candado": la firma humana sigue siendo imprescindible.
// Un candado escrito a mano no es de fiar: lo autentica la comprobación en línea (verify-sources.mjs --check).
//
// Uso:  node seo-engine/sources/verify-citations.mjs [--registry <ruta>] [--content <carpeta>]
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArticles } from "../blog-render.mjs";
import {
  ENGINE_BY_AUTHORITY,
  FAILED_REASONS,
  NORMATIVE_BINDINGS,
  REVIEW_REASONS,
  ackProblems,
  assertRegistry,
  blockIdFor,
  citationProblems,
  locatorFitsAuthority,
  lockProblems,
  registryEntryHash,
  urlProblem,
} from "./schema.mjs";
import { normalizeText, sha256Hex } from "./text.mjs";

export const LOCK_MAX_AGE_DAYS = 30;
const DAY = 86_400_000;
// Referencias normativas que el cuerpo puede mencionar: "Ley Orgánica 3/2018", "Real Decreto 39/1997", "BOE-A-2018-16673".
const NORM_MENTION = /\b(?:Ley Orgánica|Ley|Real Decreto-ley|Real Decreto Legislativo|Real Decreto|Orden|Reglamento)\s+(\d{1,4}\/\d{4})\b/g;
const BOE_MENTION = /\bBOE-[A-Z]-\d{4}-\d+\b/g;

export function loadRegistry(path) {
  return assertRegistry(JSON.parse(readFileSync(path, "utf8")));
}

const itemFor = (citation, source, reasons) => {
  const failed = reasons.filter((reason) => FAILED_REASONS.includes(reason));
  const review = reasons.filter((reason) => REVIEW_REASONS.includes(reason));
  return { citation, source, status: failed.length ? "failed" : review.length ? "needs_review" : "verified", failed, review };
};

export function verifyArticleCitations({ meta, body }, registry, { now = new Date(), maxLockAgeDays = LOCK_MAX_AGE_DAYS } = {}) {
  const approved = meta.review_status === "approved";
  const today = now.toISOString().slice(0, 10);
  const reference = Date.parse(`${meta.approved_at ?? today}T00:00:00Z`);
  const bySource = new Map(registry.sources.map((entry) => [entry.id, entry]));
  const citations = Array.isArray(meta.citations) ? meta.citations : [];
  const acks = Array.isArray(meta.review_ack) ? meta.review_ack : [];
  const items = [];

  const ackShape = ackProblems(meta.review_ack);
  if (ackShape.length) items.push(itemFor("(artículo)", "-", ["cita_invalida"]));
  if (meta.citations !== undefined && !Array.isArray(meta.citations)) items.push(itemFor("(artículo)", "-", ["cita_invalida"]));
  if (approved && citations.length === 0) items.push(itemFor("(artículo)", "-", ["articulo_sin_citas"]));

  const ids = new Set();
  citations.forEach((citation, index) => {
    const problems = citationProblems(citation, `citations[${index}]`);
    if (problems.length || ids.has(citation?.id)) return items.push(itemFor(citation?.id ?? `citations[${index}]`, citation?.source ?? "-", ["cita_invalida"]));
    ids.add(citation.id);
    const entry = bySource.get(citation.source);
    if (!entry) return items.push(itemFor(citation.id, citation.source, ["fuente_desconocida"]));
    const reasons = [];
    // Solo la norma (BOE) puede apoyar lo que dice la norma; las guías y los criterios orientan, no obligan.
    if (citation.type === "norma" && !NORMATIVE_BINDINGS.includes(entry.binding)) reasons.push(entry.binding === "criterio_administrativo" ? "criterio_como_norma" : "guia_como_norma");
    if (!locatorFitsAuthority(citation.locator, entry.authority)) reasons.push("localizador_incompatible");
    reasons.push(...lockReasons(citation, entry, { today, reference, maxLockAgeDays }));
    items.push(itemFor(citation.id, citation.source, reasons));
  });

  // Referencias normativas del cuerpo sin cita registrada (heurística; ver docs/blog-sources.md).
  const covered = new Set();
  for (const citation of citations) {
    const entry = bySource.get(citation?.source);
    if (entry?.official_ref.numero_oficial) covered.add(entry.official_ref.numero_oficial);
    if (entry?.official_ref.boe_id) covered.add(entry.official_ref.boe_id);
  }
  const mentions = new Set([...body.matchAll(NORM_MENTION)].map((m) => m[1]).concat([...body.matchAll(BOE_MENTION)].map((m) => m[0])));
  if ([...mentions].some((mention) => !covered.has(mention))) items.push(itemFor("(cuerpo)", "-", ["referencia_sin_cita"]));

  // Reconocimientos: cada motivo de revisión debe estar reconocido; un reconocimiento sin uso es un error.
  const used = new Set();
  for (const item of items) {
    item.acknowledged = [];
    item.pending = [];
    for (const reason of item.review) {
      const hit = acks.findIndex((ack, i) => !used.has(i) && ack.citation === item.citation && ack.reason === reason);
      if (hit >= 0) {
        used.add(hit);
        item.acknowledged.push(reason);
      } else item.pending.push(reason);
    }
    item.blocking = item.failed.length > 0 || item.pending.length > 0;
  }
  acks.forEach((ack, i) => {
    if (!used.has(i)) items.push({ ...itemFor(ack.citation, "-", ["ack_sin_uso"]), acknowledged: [], pending: [], blocking: true });
  });

  return { slug: meta.slug, approved, items, blocking: approved && items.some((item) => item.blocking) };
}

function lockReasons(citation, entry, { today, reference, maxLockAgeDays }) {
  const lock = citation.lock;
  if (lock === undefined) return ["sin_candado"];
  if (lockProblems(lock).length || lock.engine !== ENGINE_BY_AUTHORITY[entry.authority]) return ["candado_inconsistente"];
  // Si la entrada del registro cambió después de calcular el candado (p. ej. para reclasificar una guía como norma),
  // el candado ya no vale: hay que volver a comprobar y volver a firmar.
  if (lock.source_sha256 !== registryEntryHash(entry)) return ["registro_modificado"];
  if (entry.authority === "BOE") {
    if (lock.boe_id !== entry.official_ref.boe_id || lock.block_id !== blockIdFor(citation.locator)) return ["candado_inconsistente"];
  } else {
    const hasDocument = entry.urls.document !== undefined;
    if (urlProblem(lock.final_url, entry.authority) || hasDocument !== (lock.document !== null) || (lock.document && urlProblem(lock.document.final_url, entry.authority))) {
      return ["candado_inconsistente"];
    }
  }
  const expectedQuote = citation.quote === undefined ? null : sha256Hex(normalizeText(citation.quote));
  if (lock.quote_sha256 !== expectedQuote) return ["cita_editada_tras_candado"];
  if (lock.verified_at > today) return ["candado_futuro"];
  const reasons = [...lock.reasons];
  if ((reference - Date.parse(`${lock.verified_at}T00:00:00Z`)) / DAY > maxLockAgeDays) reasons.push("candado_caducado");
  return reasons;
}

// ---- CLI -----------------------------------------------------------------------------------
export function formatItem(item) {
  const tags = [...item.failed.map((r) => `✗${r}`), ...item.pending.map((r) => `?${r}`), ...item.acknowledged.map((r) => `✓reconocido:${r}`)];
  return `${item.status.toUpperCase().padEnd(12)} ${item.citation} (${item.source})${tags.length ? ` — ${tags.join(", ")}` : ""}`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : fallback);
  try {
    const registryPath = option("--registry", resolve(root, "content/sources/registry.json"));
    const articles = loadArticles(option("--content", resolve(root, "content/blog")));
    const needsRegistry = articles.some(({ meta }) => meta.citations !== undefined || meta.review_status === "approved");
    if (needsRegistry && !existsSync(registryPath)) throw new Error(`falta el registro de fuentes (${registryPath})`);
    const registry = needsRegistry ? loadRegistry(registryPath) : { version: 1, sources: [] };
    let blocking = 0;
    for (const article of articles) {
      const result = verifyArticleCitations(article, registry);
      console.log(`${result.blocking ? "BLOQUEA" : "ok     "} ${result.slug}${result.approved ? "" : " (borrador: informativo)"}`);
      for (const item of result.items) console.log(`    ${formatItem(item)}`);
      if (result.blocking) blocking++;
    }
    if (!articles.length) console.log("Sin artículos: nada que verificar.");
    process.exit(blocking ? 1 : 0);
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  }
}
