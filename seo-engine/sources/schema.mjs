// Esquema del registro de fuentes jurídicas oficiales y de las citas de los artículos (sin dependencias).
// Todo es estricto: una clave desconocida es un error, de modo que nadie pueda "colar" campos como
// `verified: true`. La naturaleza jurídica de una fuente (`binding`) se DERIVA de su tipo, no se escribe a mano.
import { isCalendarDate } from "../blog-render.mjs";
import { canonicalJson, sha256Hex } from "./text.mjs";

export const AUTHORITIES = ["BOE", "AEPD", "INSST"];
export const HOSTS = { BOE: ["www.boe.es"], AEPD: ["www.aepd.es"], INSST: ["www.insst.es"] };

// Tipo de fuente → naturaleza jurídica. Tres categorías distintas y una intermedia:
//  - disposicion: legislación VINCULANTE (la publicación oficial del BOE);
//  - texto_consolidado: texto INFORMATIVO (el BOE lo declara informativo);
//  - criterio_administrativo: criterio de una autoridad (informes, resoluciones, criterios): orienta pero no es norma;
//  - guia: guía técnica NO VINCULANTE (AEPD, INSST).
export const BINDING_BY_KIND = {
  disposicion: "vinculante",
  texto_consolidado: "informativo",
  criterio_administrativo: "criterio_administrativo",
  guia: "no_vinculante",
};
export const KINDS_BY_AUTHORITY = { BOE: ["disposicion", "texto_consolidado"], AEPD: ["guia", "criterio_administrativo"], INSST: ["guia"] };
// Solo estas naturalezas pueden apoyar una afirmación sobre lo que DICE LA NORMA (type "norma").
export const NORMATIVE_BINDINGS = ["vinculante", "informativo"];
export const ENGINE_BY_AUTHORITY = { BOE: "boe-api-v1", AEPD: "web-v1", INSST: "web-v1" };

// Motivos por los que una cita NO es válida automáticamente. `failed` bloquea; `needs_review` exige revisión humana.
export const FAILED_REASONS = [
  "sin_candado",
  "fuente_desconocida",
  "registro_no_coincide",
  "registro_modificado",
  "guia_como_norma",
  "criterio_como_norma",
  "localizador_incompatible",
  "norma_derogada",
  "norma_anulada",
  "vigencia_agotada",
  "identificador_inexistente",
  "url_inexistente",
  "redireccion_no_oficial",
  "locator_no_encontrado",
  "sin_version_vigente",
  "cita_no_encontrada",
  "cita_solo_en_version_anterior",
  "cita_editada_tras_candado",
  "candado_inconsistente",
  "candado_futuro",
  "cita_invalida",
  "ack_sin_uso",
];
export const REVIEW_REASONS = [
  "solo_existencia",
  "vigencia_no_acreditable",
  "pdf_sin_verificacion_textual",
  "titulo_no_coincide",
  "tipo_inesperado",
  "url_redirigida",
  "consolidacion_no_finalizada",
  "version_con_vigencia_futura",
  "norma_modificada_tras_candado",
  "fuente_modificada",
  "candado_caducado",
  "fuente_inalcanzable",
  "bloqueado_por_robots",
  "fuente_demasiado_grande",
  "referencia_sin_cita",
  "articulo_sin_citas",
];

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOE_ID = /^BOE-[A-Z]-\d{4}-\d+$/;
const NUMERO_OFICIAL = /^\d+\/\d{4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPACT_DATE = /^\d{8}$/;
const METADATA_STAMP = /^\d{8}(?:T\d{6}Z)?$/;
const ARTICLE = /^\d{1,4}(?:\s?[a-z]{2,12})?$/i;
const BLOCK = /^[a-z0-9-]{1,24}$/;

const onlyKeys = (object, allowed, where, problems) => {
  for (const key of Object.keys(object ?? {})) if (!allowed.includes(key)) problems.push(`${where}: clave no permitida "${key}"`);
};
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export function urlProblem(value, authority) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "URL no válida";
  }
  if (url.protocol !== "https:") return "solo https";
  if (url.username || url.password) return "URL con credenciales";
  if (!HOSTS[authority].includes(url.hostname)) return `el host ${url.hostname} no es oficial para ${authority} (${HOSTS[authority].join(", ")})`;
  return null;
}

// Hash de una entrada del registro. Va en cada candado: si la entrada cambia después de firmar (por ejemplo, para
// reclasificar una guía como norma), el candado deja de coincidir y la aprobación hay que repetirla.
export const registryEntryHash = (entry) => sha256Hex(canonicalJson(entry));

// ---- Registro ----------------------------------------------------------------------------
export function registryProblems(registry, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.sources)) {
    return ["el registro debe ser { version: 1, sources: [...] }"];
  }
  onlyKeys(registry, ["version", "sources"], "registro", problems);
  const seen = new Set();
  registry.sources.forEach((entry, index) => {
    const where = `fuente #${index + 1}${entry?.id ? ` (${entry.id})` : ""}`;
    if (!isObject(entry)) return problems.push(`${where}: debe ser un objeto`);
    onlyKeys(entry, ["id", "authority", "kind", "binding", "title", "official_ref", "urls", "added_at"], where, problems);
    if (!ID.test(entry.id ?? "")) problems.push(`${where}: id inválido (minúsculas, números y guiones)`);
    else if (seen.has(entry.id)) problems.push(`${where}: id duplicado`);
    seen.add(entry.id);
    if (!AUTHORITIES.includes(entry.authority)) return problems.push(`${where}: authority debe ser ${AUTHORITIES.join(", ")}`);
    if (!KINDS_BY_AUTHORITY[entry.authority].includes(entry.kind)) {
      problems.push(`${where}: ${entry.authority} solo admite kind ${KINDS_BY_AUTHORITY[entry.authority].join(" o ")}`);
    }
    if (entry.binding !== BINDING_BY_KIND[entry.kind]) problems.push(`${where}: binding debe ser "${BINDING_BY_KIND[entry.kind]}" para kind "${entry.kind}"`);
    if (typeof entry.title !== "string" || entry.title.trim().length < 5) problems.push(`${where}: falta title`);
    if (!isCalendarDate(entry.added_at) || entry.added_at > today) problems.push(`${where}: added_at debe ser una fecha real no futura`);
    const ref = entry.official_ref;
    if (!isObject(ref)) problems.push(`${where}: falta official_ref`);
    else {
      onlyKeys(ref, ["boe_id", "numero_oficial", "eli", "reference"], `${where}.official_ref`, problems);
      if (entry.authority === "BOE") {
        if (!BOE_ID.test(ref.boe_id ?? "")) problems.push(`${where}: official_ref.boe_id inválido (BOE-A-AAAA-NNNN)`);
        if (ref.numero_oficial !== undefined && !NUMERO_OFICIAL.test(ref.numero_oficial)) problems.push(`${where}: numero_oficial debe ser N/AAAA`);
        if (ref.eli !== undefined && urlProblem(ref.eli, "BOE")) problems.push(`${where}: eli ${urlProblem(ref.eli, "BOE")}`);
      } else if (typeof ref.reference !== "string" || ref.reference.trim().length < 8) {
        problems.push(`${where}: las fuentes de AEPD e INSST necesitan official_ref.reference (el título oficial del documento)`);
      }
    }
    if (!isObject(entry.urls)) problems.push(`${where}: falta urls`);
    else {
      const allowed = entry.authority === "BOE" ? ["canonical", "consolidated"] : ["canonical", "document", "index"];
      onlyKeys(entry.urls, allowed, `${where}.urls`, problems);
      if (urlProblem(entry.urls.canonical ?? "", entry.authority)) problems.push(`${where}: urls.canonical ${urlProblem(entry.urls.canonical ?? "", entry.authority)}`);
      for (const key of allowed.filter((name) => name !== "canonical")) {
        if (entry.urls[key] !== undefined && urlProblem(entry.urls[key], entry.authority)) problems.push(`${where}: urls.${key} ${urlProblem(entry.urls[key], entry.authority)}`);
      }
    }
  });
  return problems;
}

export function assertRegistry(registry, options) {
  const problems = registryProblems(registry, options);
  if (problems.length) throw new Error(`registro de fuentes inválido:\n  - ${problems.join("\n  - ")}`);
  return registry;
}

// ---- Candado, citas y reconocimientos -----------------------------------------------------
const COMMON_LOCK_KEYS = ["verified_at", "engine", "source_sha256", "quote_sha256", "status", "reasons"];
const BOE_LOCK_KEYS = ["boe_id", "block_id", "block_fecha_actualizacion", "norma_fecha_actualizacion", "version_fecha_vigencia", "text_sha256"];
const WEB_LOCK_KEYS = ["final_url", "http_status", "content_type", "content_sha256", "text_sha256", "last_modified", "document"];
const DOCUMENT_KEYS = ["final_url", "content_type", "content_sha256", "last_modified"];

export function lockProblems(lock) {
  const problems = [];
  if (!isObject(lock)) return ["el candado debe ser un objeto"];
  const engine = lock.engine;
  if (!Object.values(ENGINE_BY_AUTHORITY).includes(engine)) problems.push('candado.engine debe ser "boe-api-v1" o "web-v1"');
  onlyKeys(lock, [...COMMON_LOCK_KEYS, ...(engine === "web-v1" ? WEB_LOCK_KEYS : BOE_LOCK_KEYS)], "candado", problems);
  if (!isCalendarDate(lock.verified_at)) problems.push("candado.verified_at debe ser una fecha real");
  if (!SHA256.test(lock.source_sha256 ?? "")) problems.push("candado.source_sha256 debe ser un SHA-256");
  if (lock.quote_sha256 !== null && !SHA256.test(lock.quote_sha256 ?? "")) problems.push("candado.quote_sha256 debe ser un SHA-256 o null");
  if (!["verified", "needs_review"].includes(lock.status)) problems.push("candado.status debe ser verified o needs_review");
  if (!Array.isArray(lock.reasons) || lock.reasons.some((reason) => !REVIEW_REASONS.includes(reason))) problems.push("candado.reasons solo admite motivos de revisión");
  else if (lock.status === "verified" && lock.reasons.length) problems.push("un candado verified no puede llevar motivos");
  else if (lock.status === "needs_review" && !lock.reasons.length) problems.push("un candado needs_review necesita motivos");
  if (engine === "boe-api-v1") {
    if (!BOE_ID.test(lock.boe_id ?? "")) problems.push("candado.boe_id inválido");
    if (!BLOCK.test(lock.block_id ?? "")) problems.push("candado.block_id inválido");
    if (!COMPACT_DATE.test(lock.block_fecha_actualizacion ?? "")) problems.push("candado.block_fecha_actualizacion debe ser AAAAMMDD");
    if (!METADATA_STAMP.test(lock.norma_fecha_actualizacion ?? "")) problems.push("candado.norma_fecha_actualizacion inválida");
    if (!COMPACT_DATE.test(lock.version_fecha_vigencia ?? "")) problems.push("candado.version_fecha_vigencia debe ser AAAAMMDD");
    if (!SHA256.test(lock.text_sha256 ?? "")) problems.push("candado.text_sha256 debe ser un SHA-256");
  } else if (engine === "web-v1") {
    if (typeof lock.final_url !== "string" || !/^https:\/\//.test(lock.final_url)) problems.push("candado.final_url debe ser una URL https");
    if (lock.http_status !== 200) problems.push("candado.http_status debe ser 200");
    if (typeof lock.content_type !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/.test(lock.content_type)) problems.push("candado.content_type inválido");
    if (!SHA256.test(lock.content_sha256 ?? "")) problems.push("candado.content_sha256 debe ser un SHA-256");
    if (lock.text_sha256 !== null && !SHA256.test(lock.text_sha256 ?? "")) problems.push("candado.text_sha256 debe ser un SHA-256 o null");
    if (lock.last_modified !== null && (typeof lock.last_modified !== "string" || lock.last_modified.length > 64)) problems.push("candado.last_modified inválido");
    if (lock.document !== null) {
      if (!isObject(lock.document)) problems.push("candado.document debe ser un objeto o null");
      else {
        onlyKeys(lock.document, DOCUMENT_KEYS, "candado.document", problems);
        if (typeof lock.document.final_url !== "string" || !/^https:\/\//.test(lock.document.final_url)) problems.push("candado.document.final_url inválida");
        if (!SHA256.test(lock.document.content_sha256 ?? "")) problems.push("candado.document.content_sha256 inválido");
        if (typeof lock.document.content_type !== "string") problems.push("candado.document.content_type inválido");
      }
    }
  }
  return problems;
}

export function citationProblems(citation, where = "cita") {
  const problems = [];
  if (!isObject(citation)) return [`${where}: debe ser un objeto`];
  onlyKeys(citation, ["id", "source", "type", "locator", "quote", "lock"], where, problems);
  if (!ID.test(citation.id ?? "")) problems.push(`${where}: id inválido`);
  if (!ID.test(citation.source ?? "")) problems.push(`${where}: source debe ser el id de una fuente del registro`);
  if (!["norma", "criterio"].includes(citation.type)) problems.push(`${where}: type debe ser "norma" o "criterio"`);
  const locator = citation.locator;
  if (!isObject(locator)) problems.push(`${where}: falta locator`);
  else {
    onlyKeys(locator, ["article", "block", "section", "page"], `${where}.locator`, problems);
    const keys = Object.keys(locator);
    if (keys.length !== 1) problems.push(`${where}: locator necesita exactamente uno de article, block, section o page`);
    else if (locator.article !== undefined && !ARTICLE.test(String(locator.article))) problems.push(`${where}: locator.article inválido`);
    else if (locator.block !== undefined && !BLOCK.test(String(locator.block))) problems.push(`${where}: locator.block inválido`);
    else if (locator.section !== undefined && (typeof locator.section !== "string" || locator.section.trim().length < 3 || locator.section.length > 160)) problems.push(`${where}: locator.section debe tener entre 3 y 160 caracteres`);
    else if (locator.page !== undefined && !(Number.isInteger(locator.page) && locator.page >= 1 && locator.page <= 2000)) problems.push(`${where}: locator.page debe ser un entero entre 1 y 2000`);
  }
  if (citation.quote !== undefined && (typeof citation.quote !== "string" || citation.quote.trim().length < 12 || citation.quote.length > 800)) {
    problems.push(`${where}: quote debe tener entre 12 y 800 caracteres`);
  }
  if (citation.lock !== undefined) problems.push(...lockProblems(citation.lock).map((problem) => `${where}: ${problem}`));
  return problems;
}

// El localizador debe ser del tipo que admite la fuente: BOE → article|block; AEPD/INSST → section|page.
export const locatorFitsAuthority = (locator, authority) => (authority === "BOE" ? locator.article !== undefined || locator.block !== undefined : locator.section !== undefined || locator.page !== undefined);

export function ackProblems(acks) {
  const problems = [];
  if (acks === undefined) return problems;
  if (!Array.isArray(acks)) return ["review_ack debe ser una lista"];
  acks.forEach((ack, index) => {
    const where = `review_ack #${index + 1}`;
    if (!isObject(ack)) return problems.push(`${where}: debe ser un objeto`);
    onlyKeys(ack, ["citation", "reason", "note"], where, problems);
    if (typeof ack.citation !== "string" || !(ID.test(ack.citation) || ["(cuerpo)", "(artículo)"].includes(ack.citation))) problems.push(`${where}: citation inválida`);
    if (!REVIEW_REASONS.includes(ack.reason)) problems.push(`${where}: reason debe ser un motivo de revisión`);
    if (typeof ack.note !== "string" || ack.note.trim().length < 10 || ack.note.length > 400) problems.push(`${where}: note debe explicar la decisión (10 a 400 caracteres)`);
  });
  return problems;
}

// Bloque del BOE que corresponde a un localizador. "5 bis" → "a5bis".
export const blockIdFor = (locator) => (locator.block !== undefined ? String(locator.block) : `a${String(locator.article).toLowerCase().replace(/\s+/g, "")}`);
