// Comprobación EN VIVO de las citas de un artículo (F2.3b): estricta, con reintentos acotados y sin escribir nada.
// Es un control TÉCNICO de fuentes: no autoriza ninguna publicación (eso sigue exigiendo la firma del responsable).
//
// Resultado por cita (`outcome`):
//   confirmed    la fuente en vivo coincide con el candado guardado.
//   changed      la fuente cambió desde el candado (fuente_modificada, norma_modificada_tras_candado o motivos nuevos): revisión legal.
//   contradicted la fuente contradice la cita o el candado (cita no encontrada, derogada, candado inconsistente, registro modificado…).
//   unreachable  no se pudo concluir tras los reintentos (red, 5xx, 429/403, soft-block, timeout). Nunca es válida.
//   unchecked    la cita no se pudo comprobar por una falta propia (sin candado, fuente desconocida, cita inválida).
//   exceptional_review  (REVISION_EXCEPCIONAL) `unreachable` de AEPD/INSST cubierto por una excepción FIRMADA y vigente (F2.3c).
//                solo transforma `unreachable`; nunca es `confirmed` ni sustituye a la aprobación del artículo.
// En modo estricto TODO lo que no sea `confirmed` bloquea. `exceptionable` marca lo que una excepción firmada futura (F2.3c)
// podría cubrir: solo `unreachable` de AEPD/INSST. El BOE inconcluso bloquea siempre y nunca es excepcionable.
import { compareWithLock, verifyBoeCitation } from "./adapters/boe.mjs";
import { compareWebWithLock, verifyWebCitation } from "./adapters/web.mjs";
import { FAILED_REASONS, citationProblems } from "./schema.mjs";
import { EXCEPTION_STATE, evaluateException } from "./exceptions.mjs";
import { verifyArticleCitations } from "./verify-citations.mjs";

export const MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY = { attempts: 3, baseMs: 2000, maxMs: 20_000 };
export const MODES = ["strict", "informative"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Reintenta SOLO lo que es transitorio (`inconclusive`). Un resultado definitivo (aunque sea negativo) no se repite.
export async function withRetries(attempt, { attempts = DEFAULT_RETRY.attempts, baseMs = DEFAULT_RETRY.baseMs, maxMs = DEFAULT_RETRY.maxMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  const total = clamp(Number.isInteger(attempts) ? attempts : DEFAULT_RETRY.attempts, 1, MAX_ATTEMPTS);
  let result;
  for (let n = 1; n <= total; n++) {
    result = await attempt(n);
    if (!result?.inconclusive) return { result, attempts: n };
    if (n < total) await sleep(Math.round(Math.min(maxMs, baseMs * 2 ** (n - 1)) * (0.5 + random() * 0.5)));
  }
  return { result, attempts: total };
}

const isBoe = (entry) => entry.authority === "BOE";

function classify(live, citation, entry) {
  if (live.inconclusive) return { outcome: "unreachable", reasons: live.reasons ?? ["fuente_inalcanzable"], exceptionable: !isBoe(entry) };
  if (live.status === "failed") return { outcome: "contradicted", reasons: live.reasons };
  const compared = isBoe(entry) ? compareWithLock(live, citation.lock) : compareWebWithLock(live, citation.lock);
  if (compared.status === "failed") return { outcome: "contradicted", reasons: compared.reasons };
  if (isBoe(entry)) return compared.status === "verified" ? { outcome: "confirmed", reasons: [] } : { outcome: "changed", reasons: compared.reasons };
  // Web: la vigencia nunca es acreditable y esos motivos permanentes ya están en el candado; solo importa lo NUEVO.
  const known = new Set(citation.lock.reasons ?? []);
  const fresh = compared.reasons.filter((reason) => !known.has(reason));
  return fresh.length ? { outcome: "changed", reasons: fresh } : { outcome: "confirmed", reasons: [] };
}

export async function liveCheckCitation({ entry, citation, boe, web, now = new Date(), retry = {} }) {
  const problems = citationProblems(citation, "cita");
  if (problems.length) return { outcome: "unchecked", reasons: ["cita_invalida"], attempts: 0 };
  if (!entry) return { outcome: "unchecked", reasons: ["fuente_desconocida"], attempts: 0 };
  if (!citation.lock) return { outcome: "unchecked", reasons: ["sin_candado"], attempts: 0 };
  const run = isBoe(entry) ? () => verifyBoeCitation({ client: boe, entry, citation, now }) : () => verifyWebCitation({ client: web, entry, citation, now });
  let done;
  try {
    done = await withRetries(run, retry);
  } catch (error) {
    // Un error inesperado nunca es éxito: se trata como inalcanzable (el BOE no es excepcionable).
    return { outcome: "unreachable", reasons: ["fuente_inalcanzable"], detail: String(error?.message ?? error), exceptionable: !isBoe(entry), attempts: 1 };
  }
  return { ...classify(done.result, citation, entry), detail: done.result.detail, attempts: done.attempts };
}

// `exceptions` (opcional): { recordsFor(slug), allowedSigners, identity, pinnedFingerprint }. Sin él no hay excepciones.
export async function liveCheckArticle({ meta, body = "" }, registry, { boe, web, now = new Date(), retry, mode = "strict", exceptions } = {}) {
  if (!MODES.includes(mode)) throw new Error(`modo inválido: ${mode}`);
  const bySource = new Map(registry.sources.map((entry) => [entry.id, entry]));
  const citations = Array.isArray(meta.citations) ? meta.citations : [];
  const items = [];
  if (meta.review_status === "approved" && citations.length === 0) items.push({ citation: "(artículo)", source: "-", outcome: "unchecked", reasons: ["articulo_sin_citas"], attempts: 0 });
  let offline = null;
  for (const citation of citations) {
    const entry = bySource.get(citation?.source);
    const item = await liveCheckCitation({ entry, citation: citation ?? {}, boe, web, now, retry });
    const out = { citation: citation?.id ?? "?", source: citation?.source ?? "-", authority: entry?.authority, ...item };
    if (exceptions && out.outcome === "unreachable" && out.exceptionable === true) {
      try {
        offline ??= verifyArticleCitations({ meta, body }, registry, { now });
        const verdict = evaluateException({
          meta, body, citation, entry,
          offlineItem: offline.items.find((i) => i.citation === citation.id),
          records: exceptions.recordsFor(meta.slug),
          allowedSigners: exceptions.allowedSigners, identity: exceptions.identity, pinnedFingerprint: exceptions.pinnedFingerprint, now,
        });
        if (verdict.status === EXCEPTION_STATE) Object.assign(out, { outcome: "exceptional_review", exception: { issued_at: verdict.issued_at, expires_at: verdict.expires_at } });
        else out.exceptionDenied = verdict.reasons;
      } catch (error) {
        out.exceptionDenied = [`error:${String(error?.message ?? error)}`]; // un error al evaluar la excepción NUNCA la concede
      }
    }
    items.push(out);
  }
  for (const item of items) item.blocking = mode === "strict" && item.outcome !== "confirmed" && item.outcome !== "exceptional_review";
  return { slug: meta.slug, mode, items, blocking: items.some((item) => item.blocking) };
}

const LABEL = { exceptional_review: EXCEPTION_STATE };
export const formatLiveItem = (item) =>
  `${(LABEL[item.outcome] ?? item.outcome.toUpperCase()).padEnd(12)} ${item.citation} (${item.source})${item.reasons?.length ? ` — ${item.reasons.join(", ")}` : ""}${item.attempts > 1 ? ` [${item.attempts} intentos]` : ""}${item.exception ? ` [documentada por el responsable; caduca ${item.exception.expires_at}; NO verificada]` : item.exceptionable ? " [excepcionable con firma]" : ""}`;

// Para tests y documentación: los motivos que nunca deben producir `confirmed`.
export const NEVER_CONFIRMED = FAILED_REASONS;
