// Adaptador web para las fuentes de la AEPD y del INSST (guías técnicas y criterios): HTML y PDF. Sin dependencias.
//
// Estas fuentes NO tienen API ni metadatos de vigencia. Por eso una cita web:
//  - nunca es `verified`: como mínimo lleva `vigencia_no_acreditable`, y por tanto exige reconocimiento humano;
//  - una URL que responde 200 NO acredita su contenido: se comprueban el título, el tipo de contenido y, en HTML,
//    que la cita aparezca literalmente; en PDF no se lee el texto (`pdf_sin_verificacion_textual`);
//  - cualquier problema de acceso (403, 429, 5xx, tiempo agotado, página de "acceso bloqueado", robots.txt, tamaño,
//    redirección fuera del dominio oficial) es "no verificado", nunca una validación.
// Se respeta robots.txt, se identifica el cliente, se limita el ritmo por host y las redirecciones se siguen a mano
// comprobando cada salto.
import { registryEntryHash, urlProblem } from "../schema.mjs";
import { contentWindow, extractHeadings, extractTitle, htmlToText } from "../html.mjs";
import { normalizeText, quoteMatches, sha256Bytes, sha256Hex } from "../text.mjs";

export const USER_AGENT = "LegalPreventSourceCheck/1.0 (+https://legalprevent.com; verificacion-de-citas)";
export const ROBOTS_TOKEN = "legalpreventsourcecheck";
export const MAX_BYTES = { html: 3_000_000, pdf: 25_000_000, other: 1_000_000 };
const MAX_REDIRECTS = 3;
const REDIRECTS = [301, 302, 303, 307, 308];
const SOFT_BLOCK = /acceso bloqueado|access denied|forbidden|just a moment|attention required|request blocked|too many requests/i;

// ---- robots.txt ------------------------------------------------------------------------------
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (!line || colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if ((field === "allow" || field === "disallow") && current && value) current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const specific = groups.filter((group) => group.agents.includes(ROBOTS_TOKEN));
  return (specific.length ? specific : groups.filter((group) => group.agents.includes("*"))).flatMap((group) => group.rules);
}

const patternRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);

// Gana la regla más específica (patrón más largo); a igualdad, Allow.
export function robotsAllows(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!patternRegex(rule.pattern).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// ---- Cliente HTTP ----------------------------------------------------------------------------
const kindOf = (contentType) => (contentType === "application/pdf" ? "pdf" : ["text/html", "application/xhtml+xml"].includes(contentType) ? "html" : "other");

export function createWebClient({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), delayMs = 1000, timeoutMs = 25000 } = {}) {
  const lastByHost = new Map();
  const robotsByHost = new Map();
  const cache = new Map();

  async function request(url) {
    const host = new URL(url).hostname;
    const wait = (lastByHost.get(host) ?? 0) + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastByHost.set(host, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" },
        signal: controller.signal,
      });
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const charset = (response.headers.get("content-type") ?? "").match(/charset=([^;\s]+)/i)?.[1] ?? "utf-8";
      const result = { status: response.status, headers: response.headers, contentType, charset, kind: kindOf(contentType) };
      if (response.status === 200) {
        const cap = MAX_BYTES[result.kind];
        if (Number(response.headers.get("content-length") ?? 0) > cap) return { ...result, tooLarge: true };
        result.buffer = Buffer.from(await response.arrayBuffer());
        if (result.buffer.length > cap) return { ...result, tooLarge: true };
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function robotsFor(url) {
    const { hostname } = new URL(url);
    if (!robotsByHost.has(hostname)) {
      let rules;
      try {
        const response = await request(`https://${hostname}/robots.txt`);
        rules = response.status === 200 ? parseRobots(response.buffer.toString("utf8")) : response.status === 404 || response.status === 410 ? [] : null;
      } catch {
        rules = null;
      }
      robotsByHost.set(hostname, rules);
    }
    return robotsByHost.get(hostname);
  }

  async function fetchResource(url, authority) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem = urlProblem(current, authority);
      if (problem) return { ok: false, error: "redireccion_no_oficial", detail: `${current}: ${problem}` };
      const rules = await robotsFor(current);
      if (rules === null) return { ok: false, error: "robots_unavailable", detail: "no se pudo leer robots.txt" };
      const target = new URL(current);
      if (!robotsAllows(rules, target.pathname + target.search)) return { ok: false, error: "robots_disallowed", detail: current };
      let response;
      try {
        response = await request(current);
      } catch (error) {
        return { ok: false, error: error.name === "AbortError" ? "timeout" : "network", detail: error.message };
      }
      if (REDIRECTS.includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, error: "unexpected_status", detail: `HTTP ${response.status} sin Location` };
        current = new URL(location, current).href;
        continue;
      }
      if (response.status === 404 || response.status === 410) return { ok: false, error: "not_found", detail: `HTTP ${response.status}` };
      if ([401, 403, 429].includes(response.status)) return { ok: false, error: "blocked", detail: `HTTP ${response.status}` };
      if (response.status >= 500) return { ok: false, error: "server_error", detail: `HTTP ${response.status}` };
      if (response.status !== 200) return { ok: false, error: "unexpected_status", detail: `HTTP ${response.status}` };
      if (response.tooLarge) return { ok: false, error: "too_large", detail: current };
      let html = null;
      if (response.kind === "html") {
        try {
          html = new TextDecoder(response.charset).decode(response.buffer);
        } catch {
          html = response.buffer.toString("utf8");
        }
        if (SOFT_BLOCK.test(extractTitle(html) ?? "")) return { ok: false, error: "soft_block", detail: "la web devolvió una página de acceso bloqueado con 200" };
      }
      const page = {
        ok: true,
        url: current,
        status: 200,
        contentType: response.contentType,
        kind: response.kind,
        bytes: response.buffer,
        lastModified: response.headers.get("last-modified") ?? null,
        text: html === null ? null : htmlToText(html),
        title: html === null ? null : extractTitle(html),
        headings: html === null ? [] : extractHeadings(html),
        window: null,
      };
      page.window = page.text === null ? null : contentWindow(page.text, page.headings);
      return page;
    }
    return { ok: false, error: "too_many_redirects", detail: url };
  }

  return {
    async get(url, authority) {
      if (cache.has(url)) return cache.get(url);
      const result = await fetchResource(url, authority);
      if (result.ok || result.error === "not_found") cache.set(url, result);
      return result;
    },
  };
}

// ---- Evaluación pura -----------------------------------------------------------------------
const unique = (list) => [...new Set(list)];
const normalizeUrl = (value) => {
  const url = new URL(value);
  url.hash = "";
  return url.href.replace(/\/$/, "");
};

function mapError(resource) {
  switch (resource.error) {
    case "not_found":
      return { failed: "url_inexistente" };
    case "redireccion_no_oficial":
      return { failed: "redireccion_no_oficial" };
    case "robots_disallowed":
      return { review: "bloqueado_por_robots" };
    case "too_large":
      return { review: "fuente_demasiado_grande" };
    default:
      return { review: "fuente_inalcanzable", inconclusive: true };
  }
}

const documentOf = (resource) => (resource ? { final_url: resource.url, content_type: resource.contentType, content_sha256: sha256Bytes(resource.bytes), last_modified: resource.lastModified } : null);

// canonical / document / index son los resultados de client.get (o null si la entrada no define esa URL).
export function evaluateWeb({ entry, citation, canonical, document = null, index = null, now = new Date() }) {
  const resources = [canonical, document, index].filter(Boolean);
  const failed = [];
  const review = [];
  let inconclusive = false;
  for (const resource of resources.filter((r) => !r.ok)) {
    const mapped = mapError(resource);
    if (mapped.failed) failed.push(mapped.failed);
    else review.push(mapped.review);
    inconclusive ||= Boolean(mapped.inconclusive);
  }
  if (failed.length) return { status: "failed", reasons: unique(failed), ...(inconclusive ? { inconclusive } : {}) };
  if (review.length) return { status: "needs_review", reasons: unique(review), inconclusive, detail: resources.find((r) => !r.ok)?.detail };

  const reasons = ["vigencia_no_acreditable"]; // no existe un metadato de vigencia en estas fuentes
  const wantPdf = /\.pdf$/i.test(new URL(entry.urls.canonical).pathname);
  if ((canonical.kind === "pdf") !== wantPdf || canonical.kind === "other") reasons.push("tipo_inesperado");
  if (document && document.kind !== "pdf") reasons.push("tipo_inesperado");
  if (normalizeUrl(canonical.url) !== normalizeUrl(entry.urls.canonical) || (document && normalizeUrl(document.url) !== normalizeUrl(entry.urls.document))) reasons.push("url_redirigida");

  const reference = normalizeText(entry.official_ref.reference).toLowerCase();
  if (canonical.kind === "html" && !unique([canonical.title, ...canonical.headings].filter(Boolean).map((t) => t.toLowerCase())).some((t) => t.includes(reference))) reasons.push("titulo_no_coincide");
  if (index && !index.text.toLowerCase().includes(reference)) reasons.push("titulo_no_coincide");

  let quoteHash = null;
  if (citation.quote === undefined) reasons.push("solo_existencia");
  else {
    quoteHash = sha256Hex(normalizeText(citation.quote));
    if (canonical.kind !== "html" || entry.urls.document) reasons.push("pdf_sin_verificacion_textual"); // la cita está en un PDF que no se lee
    else if (!quoteMatches(canonical.text, citation.quote).ok) return { status: "failed", reasons: ["cita_no_encontrada"] };
  }
  const finalReasons = unique(reasons);
  return {
    status: "needs_review",
    reasons: finalReasons,
    lock: {
      verified_at: now.toISOString().slice(0, 10),
      engine: "web-v1",
      source_sha256: registryEntryHash(entry),
      final_url: canonical.url,
      http_status: 200,
      content_type: canonical.contentType,
      // HTML: huella de la ventana de contenido (el HTML crudo varía en cada descarga). PDF: hash de los bytes.
      content_sha256: canonical.kind === "html" ? sha256Hex(canonical.window) : sha256Bytes(canonical.bytes),
      text_sha256: canonical.kind === "html" ? sha256Hex(canonical.window) : null,
      last_modified: canonical.lastModified,
      document: documentOf(document),
      quote_sha256: quoteHash,
      status: "needs_review",
      reasons: finalReasons,
    },
  };
}

// Compara con el candado: el contenido de una web cambia por muchos motivos y no se puede probar una falsificación,
// así que un cambio es `fuente_modificada` (revisión); la cita y el título se recalculan en vivo, no se heredan.
export function compareWebWithLock(live, lock) {
  if (live.status === "failed" || live.inconclusive || !live.lock) return live;
  if (live.lock.source_sha256 !== lock.source_sha256) return { status: "failed", reasons: ["registro_modificado"] };
  const changed =
    live.lock.content_sha256 !== lock.content_sha256 ||
    live.lock.text_sha256 !== lock.text_sha256 ||
    (live.lock.document?.content_sha256 ?? null) !== (lock.document?.content_sha256 ?? null);
  const reasons = unique([...live.reasons, ...(changed ? ["fuente_modificada"] : [])]);
  return { status: "needs_review", reasons, lock: live.lock };
}

// Verificación en línea de una cita web. Cualquier excepción inesperada = no verificado.
export async function verifyWebCitation({ client, entry, citation, now = new Date() }) {
  try {
    const canonical = await client.get(entry.urls.canonical, entry.authority);
    const document = entry.urls.document ? await client.get(entry.urls.document, entry.authority) : null;
    const index = entry.urls.index ? await client.get(entry.urls.index, entry.authority) : null;
    return evaluateWeb({ entry, citation, canonical, document, index, now });
  } catch (error) {
    return { status: "needs_review", reasons: ["fuente_inalcanzable"], inconclusive: true, detail: error.message };
  }
}
