// Comprobación programada de deriva de las citas de los artículos publicados (ver sources/drift.mjs). Solo lectura.
// Se ejecuta desde `main` (workflow programado): el código y los datos son los de la rama por defecto, no hay PR de por medio.
//
// Variables: REPO_DIR (por defecto, el directorio actual) · BLOG_APPROVER_FINGERPRINT (huella fijada; obligatoria si hay artículos
// aprobados) · LIVE_ATTEMPTS (1..5, por defecto 3) · DRIFT_MAX_CITATIONS (1..200, por defecto 60) · DRIFT_OUT (ruta opcional para
// guardar el informe JSON; en el workflow no se usa) · GITHUB_STEP_SUMMARY.
// Salida: 0 todo OK · 1 revisión jurídica necesaria / sin comprobar / error interno · 3 solo inconclusos.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadArticles } from "../blog-render.mjs";
import { verifySignedApprovals } from "../approval-signature.mjs";
import { createBoeClient } from "../sources/adapters/boe.mjs";
import { createWebClient } from "../sources/adapters/web.mjs";
import { loadRegistry } from "../sources/verify-citations.mjs";
import { DEFAULT_MAX_CITATIONS, STATES, driftCheck } from "../sources/drift.mjs";
import { Report, humanLogin } from "./common.mjs";
import { safeText } from "./sanitize.mjs";

const integer = (value, fallback, min, max, name) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  return n;
};

const report = new Report("drift");
let code = 1;
try {
  const root = resolve(process.env.REPO_DIR || process.cwd());
  const attempts = integer(process.env.LIVE_ATTEMPTS, 3, 1, 5, "LIVE_ATTEMPTS");
  const maxCitations = integer(process.env.DRIFT_MAX_CITATIONS, DEFAULT_MAX_CITATIONS, 1, 200, "DRIFT_MAX_CITATIONS");
  const approved = loadArticles(resolve(root, "content/blog")).filter(({ meta }) => meta.review_status === "approved");
  report.info(`Artículos aprobados (publicados): ${approved.length}. Hasta ${attempts} intentos por cita transitoria; presupuesto ${maxCitations} citas.`);
  report.row(["artículos aprobados", String(approved.length)]);

  if (!approved.length) {
    report.info("Sin artículos publicados: nada que comprobar.");
    code = 0;
  } else {
    const registryPath = resolve(root, "content/sources/registry.json");
    if (!existsSync(registryPath)) throw new Error("falta content/sources/registry.json y hay artículos aprobados");
    const registry = loadRegistry(registryPath);
    const signed = verifySignedApprovals({ root, identity: humanLogin(), pinnedFingerprint: process.env.BLOG_APPROVER_FINGERPRINT ?? "" });
    const approvals = new Map(signed.map((s) => [s.slug, { ok: s.ok, reason: s.reason }]));

    const result = await driftCheck({ articles: approved, approvals, registry, boe: createBoeClient(), web: createWebClient(), retry: { attempts }, maxCitations });
    for (const [label, key] of [["OK", "ok"], ["revisión jurídica necesaria", "review"], ["inconclusos", "inconclusive"], ["sin comprobar", "unchecked"]]) report.row([label, String(result.summary[key])]);
    for (const article of result.articles) {
      report.row([article.slug, article.state]);
      if (article.state === STATES.ok) continue;
      for (const f of article.findings) {
        const text = `${safeText(article.slug)}: ${f.state}${f.citation ? ` · cita ${safeText(f.citation)} (${safeText(f.source)}): ${f.outcome} — ${f.reasons.map((r) => safeText(r, 60)).join(", ")}` : ` · ${f.kind}: ${safeText(f.detail ?? "", 200)}`}`;
        if (f.state === STATES.inconclusive) report.warn(text);
        else report.problem(text);
      }
    }
    if (process.env.DRIFT_OUT) writeFileSync(resolve(process.env.DRIFT_OUT), `${JSON.stringify(result, null, 2)}\n`);
    code = result.exit;
    report.info(code === 0 ? "Todas las citas publicadas coinciden con sus fuentes." : code === 3 ? "No se detectó deriva, pero hay citas que no se pudieron comprobar: NO es un resultado satisfactorio." : "Hay artículos publicados que necesitan revisión jurídica.");
  }
  report.flush(code === 0 ? "CORRECTO" : code === 3 ? "INCONCLUSO" : "REVISIÓN JURÍDICA NECESARIA");
} catch (error) {
  report.problem(`error interno o entrada inválida: ${error?.message ?? error}`);
  report.flush("FALLO (falla cerrado)");
  code = 1;
}
process.exit(code);
