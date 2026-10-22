// Comprobación PROGRAMADA de deriva (F2.3d): ¿siguen coincidiendo con sus fuentes oficiales las citas de los artículos YA
// publicados? Solo lectura: no modifica ni despublica nada, no aplica excepciones y no autoriza nada. Su único efecto es
// dejar constancia (informe) y avisar de que hace falta revisión jurídica.
//
// Estado por artículo:
//   OK                          todas las citas coinciden con el candado (`confirmed`).
//   REVISION_JURIDICA_NECESARIA la fuente cambió (`changed`), contradice la cita (`contradicted`), la cita no se puede comprobar
//                               (`unchecked`) o la aprobación firmada del artículo ya no es válida.
//   INCONCLUSO                  no se pudo comprobar (`unreachable`) y no hay deriva detectada: NO es un éxito.
//   NO_COMPROBADO               superó el presupuesto de la ejecución: nunca se omite en silencio.
// Código de salida: 0 todo OK · 1 hay revisión jurídica necesaria o artículos sin comprobar · 3 solo inconclusos.
// Una excepción firmada (F2.3c) NO se aplica aquí: un artículo publicado cuya fuente deja de responder queda INCONCLUSO.
import { liveCheckArticle } from "./live-check.mjs";

export const STATES = { ok: "OK", review: "REVISION_JURIDICA_NECESARIA", inconclusive: "INCONCLUSO", unchecked: "NO_COMPROBADO" };
export const DEFAULT_MAX_CITATIONS = 60;
const REVIEW_OUTCOMES = ["changed", "contradicted", "unchecked"];

const countCitations = (meta) => (Array.isArray(meta.citations) ? meta.citations.length : 0);

// `articles`: [{ meta, body }] de los artículos aprobados. `approvals`: Map slug → { ok, reason } (firma vigente del responsable).
export async function driftCheck({ articles, approvals, registry, boe, web, now = new Date(), retry, maxCitations = DEFAULT_MAX_CITATIONS }) {
  const results = [];
  let budget = maxCitations;
  for (const article of [...articles].sort((a, b) => String(a.meta.slug).localeCompare(String(b.meta.slug)))) {
    const slug = article.meta.slug;
    const findings = [];
    const approval = approvals.get(slug);
    if (!approval?.ok) findings.push({ kind: "aprobacion", state: STATES.review, detail: approval?.reason ?? "sin verificación de la aprobación firmada" });

    const needed = Math.max(1, countCitations(article.meta));
    if (needed > budget) {
      results.push({ slug, state: STATES.unchecked, findings: [...findings, { kind: "presupuesto", state: STATES.unchecked, detail: `superaría el presupuesto de ${maxCitations} citas por ejecución` }] });
      continue;
    }
    budget -= needed;

    const live = await liveCheckArticle(article, registry, { boe, web, now, retry, mode: "informative" }); // sin `exceptions`, a propósito
    for (const item of live.items) {
      if (item.outcome === "confirmed") continue;
      findings.push({
        kind: "cita",
        citation: item.citation,
        source: item.source,
        outcome: item.outcome,
        reasons: item.reasons ?? [],
        state: REVIEW_OUTCOMES.includes(item.outcome) ? STATES.review : STATES.inconclusive,
        ...(item.detail ? { detail: String(item.detail) } : {}),
      });
    }
    const state = findings.some((f) => f.state === STATES.review) ? STATES.review : findings.some((f) => f.state === STATES.inconclusive) ? STATES.inconclusive : STATES.ok;
    results.push({ slug, state, findings });
  }
  const count = (state) => results.filter((r) => r.state === state).length;
  const needsReview = count(STATES.review) + count(STATES.unchecked);
  const exit = needsReview > 0 ? 1 : count(STATES.inconclusive) > 0 ? 3 : 0;
  return { generated_at: now.toISOString(), articles: results, summary: { total: results.length, ok: count(STATES.ok), review: count(STATES.review), inconclusive: count(STATES.inconclusive), unchecked: count(STATES.unchecked) }, exit };
}
