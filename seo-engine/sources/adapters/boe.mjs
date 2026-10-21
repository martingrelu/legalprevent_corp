// Adaptador de la API de datos abiertos del BOE (legislación consolidada). Sin dependencias ni claves.
//   /id/{id}/metadatos        JSON: vigencia, derogación, anulación, estado de consolidación, ELI
//   /id/{id}/texto/indice     JSON: bloques (a5 = artículo 5) con su fecha_actualizacion
//   /id/{id}/texto/bloque/{b} XML: versiones del bloque con fecha_publicacion y fecha_vigencia
// El texto consolidado es INFORMATIVO (solo la publicación en el BOE es oficial): se guarda así en el registro.
//
// Principio: cualquier duda se convierte en `needs_review` o `failed`, nunca en `verified`. Un error de red,
// una respuesta inesperada o un 5xx es `fuente_inalcanzable` (no verificado), no una validación.
import { blockIdFor } from "../schema.mjs";
import { normalizeText, quoteMatches, sha256Hex } from "../text.mjs";

export const BOE_API = "https://www.boe.es/datosabiertos/api/legislacion-consolidada/id";
export const USER_AGENT = "LegalPreventSourceCheck/1.0 (+https://legalprevent.com; verificacion-de-citas)";
const BOE_ID = /^BOE-[A-Z]-\d{4}-\d+$/;
const BLOCK_ID = /^[a-z0-9-]{1,24}$/;

// ---- Análisis de respuestas ------------------------------------------------------------------
export function parseMetadata(text) {
  let data;
  try {
    const json = JSON.parse(text);
    data = Array.isArray(json.data) ? json.data[0] : json.data;
  } catch {
    throw new Error("metadatos: la respuesta no es JSON");
  }
  const required = ["identificador", "titulo", "fecha_actualizacion", "estatus_derogacion", "estatus_anulacion", "vigencia_agotada", "numero_oficial"];
  if (!data || required.some((key) => typeof data[key] !== "string") || typeof data.estado_consolidacion?.codigo !== "string") {
    throw new Error("metadatos: respuesta inesperada del BOE");
  }
  return {
    boeId: data.identificador,
    title: data.titulo,
    numeroOficial: data.numero_oficial,
    fechaActualizacion: data.fecha_actualizacion,
    derogada: data.estatus_derogacion,
    anulada: data.estatus_anulacion,
    vigenciaAgotada: data.vigencia_agotada,
    consolidacion: data.estado_consolidacion.codigo,
    urlEli: data.url_eli ?? null,
    urlHtml: data.url_html_consolidada ?? null,
  };
}

export function parseIndex(text) {
  let blocks;
  try {
    const json = JSON.parse(text);
    blocks = (Array.isArray(json.data) ? json.data[0] : json.data)?.bloque;
  } catch {
    throw new Error("índice: la respuesta no es JSON");
  }
  if (!Array.isArray(blocks)) throw new Error("índice: respuesta inesperada del BOE");
  return new Map(blocks.map((block) => [block.id, { titulo: block.titulo, fechaActualizacion: block.fecha_actualizacion }]));
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decode = (text) =>
  text
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
const attribute = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

export function parseBlock(xml) {
  if (!/<code>200<\/code>/.test(xml)) throw new Error("bloque: la respuesta del BOE no es un 200");
  const open = xml.match(/<bloque\b[^>]*>/);
  if (!open) throw new Error("bloque: respuesta sin <bloque>");
  const versions = xml
    .split(/<version\b/)
    .slice(1)
    .map((chunk) => {
      const head = chunk.slice(0, chunk.indexOf(">") + 1);
      const paragraphs = [...chunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) => decode(match[1].replace(/<[^>]+>/g, " ")));
      return {
        fechaPublicacion: attribute(head, "fecha_publicacion"),
        fechaVigencia: attribute(head, "fecha_vigencia"),
        idNorma: attribute(head, "id_norma"),
        text: paragraphs.join("\n"),
      };
    });
  if (!versions.length || versions.some((version) => !/^\d{8}$/.test(version.fechaVigencia) || !version.text.trim())) {
    throw new Error("bloque: versiones ausentes o sin fecha de vigencia");
  }
  return { id: attribute(open[0], "id"), titulo: attribute(open[0], "titulo"), tipo: attribute(open[0], "tipo"), versions };
}

// Versión en vigor a una fecha (AAAAMMDD): la de mayor fecha_vigencia que no sea futura.
export function versionsAt(block, today) {
  const sorted = [...block.versions].sort((a, b) => a.fechaVigencia.localeCompare(b.fechaVigencia));
  const inForce = sorted.filter((version) => version.fechaVigencia <= today);
  return { current: inForce.at(-1) ?? null, earlier: inForce.slice(0, -1), future: sorted.filter((version) => version.fechaVigencia > today) };
}

const compactDate = (now) => now.toISOString().slice(0, 10).replace(/-/g, "");

// ---- Evaluación pura de una cita contra los datos del BOE -----------------------------------
// Devuelve { status, reasons, lock? }. `failed` nunca produce candado.
export function evaluateBoe({ entry, citation, meta, index, block, now = new Date() }) {
  const failed = [];
  const review = [];
  const today = compactDate(now);
  if (entry.official_ref.boe_id !== meta.boeId || (entry.official_ref.numero_oficial && entry.official_ref.numero_oficial !== meta.numeroOficial)) {
    return { status: "failed", reasons: ["registro_no_coincide"] };
  }
  if (meta.derogada !== "N") failed.push("norma_derogada");
  if (meta.anulada !== "N") failed.push("norma_anulada");
  if (meta.vigenciaAgotada !== "N") failed.push("vigencia_agotada");
  if (meta.consolidacion !== "3") review.push("consolidacion_no_finalizada");

  const blockId = blockIdFor(citation.locator);
  if (!index.has(blockId) || !block) return { status: "failed", reasons: [...failed, "locator_no_encontrado"] };
  const { current, earlier, future } = versionsAt(block, today);
  if (!current) return { status: "failed", reasons: [...failed, "sin_version_vigente"] };
  if (future.length) review.push("version_con_vigencia_futura");

  let quoteHash = null;
  if (citation.quote === undefined) review.push("solo_existencia");
  else {
    quoteHash = sha256Hex(normalizeText(citation.quote));
    if (!quoteMatches(current.text, citation.quote).ok) {
      failed.push(earlier.some((version) => quoteMatches(version.text, citation.quote).ok) ? "cita_solo_en_version_anterior" : "cita_no_encontrada");
    }
  }
  if (failed.length) return { status: "failed", reasons: failed };

  const status = review.length ? "needs_review" : "verified";
  return {
    status,
    reasons: review,
    lock: {
      verified_at: now.toISOString().slice(0, 10),
      engine: "boe-api-v1",
      boe_id: meta.boeId,
      block_id: blockId,
      block_fecha_actualizacion: index.get(blockId).fechaActualizacion,
      norma_fecha_actualizacion: meta.fechaActualizacion,
      version_fecha_vigencia: current.fechaVigencia,
      text_sha256: sha256Hex(normalizeText(current.text)),
      quote_sha256: quoteHash,
      status,
      reasons: review,
    },
  };
}

// Compara una evaluación en vivo con el candado guardado. Un candado cuyo texto difiere de la fuente SIN que la
// fuente haya cambiado desde su fecha de comprobación es inconsistente (forjado o erróneo): `failed`.
export function compareWithLock(live, lock) {
  if (live.status === "failed") return live;
  const verifiedAt = lock.verified_at.replace(/-/g, "");
  const reasons = [];
  if (live.lock.text_sha256 !== lock.text_sha256) {
    if (live.lock.block_fecha_actualizacion <= verifiedAt) return { status: "failed", reasons: ["candado_inconsistente"] };
    reasons.push("fuente_modificada");
  }
  if (live.lock.block_fecha_actualizacion > verifiedAt && !reasons.includes("fuente_modificada")) reasons.push("norma_modificada_tras_candado");
  const all = [...new Set([...reasons, ...live.reasons])];
  return { status: all.length ? "needs_review" : "verified", reasons: all, lock: live.lock };
}

// ---- Cliente con límite de ritmo, caché y errores controlados -------------------------------
export function createBoeClient({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), delayMs = 1000, timeoutMs = 25000 } = {}) {
  let last = 0;
  const cache = new Map();
  async function get(path, accept) {
    const key = `${accept}|${path}`;
    if (cache.has(key)) return cache.get(key);
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${BOE_API}/${path}`, { headers: { Accept: accept, "User-Agent": USER_AGENT }, signal: controller.signal });
      const result = { status: response.status, text: await response.text() };
      if (result.status === 200 || result.status === 404) cache.set(key, result);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  const checkedId = (id) => {
    if (!BOE_ID.test(id)) throw new Error(`identificador BOE inválido: ${id}`);
    return id;
  };
  return {
    async metadata(id) {
      const { status, text } = await get(`${checkedId(id)}/metadatos`, "application/json");
      if (status === 404) return null;
      if (status !== 200) throw new Error(`HTTP ${status} al leer los metadatos`);
      return parseMetadata(text);
    },
    async index(id) {
      const { status, text } = await get(`${checkedId(id)}/texto/indice`, "application/json");
      if (status !== 200) throw new Error(`HTTP ${status} al leer el índice`);
      return parseIndex(text);
    },
    async block(id, blockId) {
      if (!BLOCK_ID.test(blockId)) throw new Error(`bloque inválido: ${blockId}`);
      const { status, text } = await get(`${checkedId(id)}/texto/bloque/${blockId}`, "application/xml");
      if (status !== 200) throw new Error(`HTTP ${status} al leer el bloque ${blockId}`);
      return parseBlock(text);
    },
  };
}

// Verificación en línea de una cita. Cualquier fallo de acceso o de formato = no verificado (nunca verified).
export async function verifyBoeCitation({ client, entry, citation, now = new Date() }) {
  try {
    const meta = await client.metadata(entry.official_ref.boe_id);
    if (!meta) return { status: "failed", reasons: ["identificador_inexistente"] };
    const index = await client.index(entry.official_ref.boe_id);
    const blockId = blockIdFor(citation.locator);
    const block = index.has(blockId) ? await client.block(entry.official_ref.boe_id, blockId) : null;
    return evaluateBoe({ entry, citation, meta, index, block, now });
  } catch (error) {
    return { status: "needs_review", reasons: ["fuente_inalcanzable"], inconclusive: true, detail: error.message };
  }
}
