// Verifica que cada artículo aprobado tiene una aprobación REAL, no solo un campo de texto.
// Solo lectura: no escribe en el repositorio ni en GitHub. El modo se elige en seo-engine/approvers.json:
//
//   "signature" (por defecto, el que usa CI): aprobación individual con firma SSH desprendida sobre el
//     SHA-256 del contenido (seo-engine/approval-signature.mjs). Offline: sin red ni tokens. Necesita la
//     variable BLOG_APPROVER_FINGERPRINT (huella fijada fuera del repositorio).
//   "pr-review" (opcional, para un segundo revisor): lo descrito a continuación.
//
// Modelo "pr-review" (aprobación ligada al SHA de la cabeza de la PR):
//   - El autor deja el artículo con review_status "approved" y approval { pr, content_sha256 }.
//   - La aprobación es la revisión "Approve" del responsable (seo-engine/approvers.json) en la PR
//     approval.pr. Es válida solo si:
//       1. su ÚLTIMA revisión decisiva (APPROVED / CHANGES_REQUESTED / DISMISSED) es APPROVED;
//       2. el contenido del artículo en el commit que aprobó (review.commit_id) tiene el hash
//          approval.content_sha256, es decir, es el mismo que hay ahora;
//       3. si se verifica dentro de esa misma PR, review.commit_id es el SHA actual de su cabeza:
//          cualquier push posterior (también de código) exige una aprobación nueva.
//   - Cualquier error, falta de dato o respuesta inesperada se trata como fallo (fail closed).
//
// Uso:  GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=… [PR_NUMBER=28 HEAD_SHA=<sha>] \
//         node seo-engine/verify-approval.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySignedApprovals } from "./approval-signature.mjs";
import { contentHash, loadArticles, parseRaw } from "./blog-render.mjs";

const DECISIVE = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

export function latestDecisiveReview(reviews, reviewerLogin) {
  const wanted = String(reviewerLogin).toLowerCase();
  return reviews
    .filter((review) => review?.user?.login?.toLowerCase() === wanted && DECISIVE.includes(review.state))
    .at(-1);
}

// `client` = { getReviews(pr) → [review], getFile(path, ref) → string }. Inyectable para probar.
export async function verifyArticle(article, { client, reviewerLogin, currentPr, headSha }) {
  const { meta } = article;
  const fail = (reason) => ({ ok: false, reason });
  const approval = meta.approval;
  if (meta.fixture === true) return fail("un artículo de pruebas (fixture) no puede estar en content/blog");
  if (meta.review_status !== "approved" || !approval) return fail("el artículo no está aprobado");
  try {
    const reviews = await client.getReviews(approval.pr);
    const latest = latestDecisiveReview(reviews, reviewerLogin);
    if (!latest) return fail(`${reviewerLogin} no ha revisado la PR #${approval.pr}`);
    if (latest.state !== "APPROVED") return fail(`la última revisión de ${reviewerLogin} es ${latest.state}`);
    if (!/^[0-9a-f]{40}$/.test(latest.commit_id ?? "")) return fail("la revisión no indica un commit válido");
    const { meta: reviewedMeta, body } = parseRaw(
      await client.getFile(`content/blog/${meta.slug}.md`, latest.commit_id),
      `${meta.slug}@${latest.commit_id.slice(0, 7)}`
    );
    if (contentHash(reviewedMeta, body) !== approval.content_sha256) {
      return fail("el contenido que aprobó el responsable no coincide con approval.content_sha256");
    }
    if (currentPr === approval.pr) {
      if (!headSha) return fail("falta el SHA de la cabeza de la PR");
      if (latest.commit_id !== headSha) return fail("la cabeza de la PR cambió después de la aprobación: requiere una nueva");
    }
    return { ok: true, reason: `aprobado por ${reviewerLogin} en la PR #${approval.pr}` };
  } catch (error) {
    return fail(`no se pudo verificar: ${error.message}`);
  }
}

export function githubClient(repo, token, fetchImpl = fetch) {
  const headers = (accept) => ({
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  return {
    async getReviews(pr) {
      const reviews = [];
      for (let page = 1; ; page++) {
        const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`, {
          headers: headers("application/vnd.github+json"),
        });
        if (!response.ok) throw new Error(`GitHub API ${response.status} al leer las revisiones de la PR #${pr}`);
        const batch = await response.json();
        if (!Array.isArray(batch)) throw new Error("respuesta inesperada de GitHub");
        reviews.push(...batch);
        if (batch.length < 100) return reviews;
      }
    },
    async getFile(path, ref) {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`, {
        headers: headers("application/vnd.github.raw+json"),
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status} al leer ${path}@${ref.slice(0, 7)}`);
      return response.text();
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
const approvers = isMain
  ? JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "approvers.json"), "utf8"))
  : undefined;

// Modo "signature" (por defecto): registros firmados con la clave del responsable; offline y sin token.
if (isMain && (approvers.mode ?? "signature") === "signature") {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let results;
  try {
    results = verifySignedApprovals({
      root,
      identity: approvers.reviewer_github,
      pinnedFingerprint: process.env.BLOG_APPROVER_FINGERPRINT,
    });
  } catch (error) {
    console.error(`ERROR no se pudo verificar: ${error.message}`);
    process.exit(1);
  }
  for (const result of results) console.log(`${result.ok ? "OK   " : "ERROR"} ${result.slug}: ${result.reason}`);
  if (!results.length) console.log("Sin artículos aprobados: nada que verificar.");
  process.exit(results.some((result) => !result.ok) ? 1 : 0);
}

// Modo opcional "pr-review": revisión APPROVED en la PR (necesita GITHUB_TOKEN con lectura de PR).
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { reviewer_github: reviewerLogin } = approvers;
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, PR_NUMBER, HEAD_SHA: headSha } = process.env;
  if (!repo || !token) {
    console.error("Faltan GITHUB_REPOSITORY o GITHUB_TOKEN");
    process.exit(2);
  }
  const currentPr = PR_NUMBER ? Number(PR_NUMBER) : undefined;
  if (PR_NUMBER && (!Number.isInteger(currentPr) || !/^[0-9a-f]{40}$/.test(headSha ?? ""))) {
    console.error("PR_NUMBER requiere HEAD_SHA (40 caracteres hexadecimales)");
    process.exit(2);
  }
  const client = githubClient(repo, token);
  const approved = loadArticles(resolve(root, "content/blog")).filter(({ meta }) => meta.review_status === "approved");
  let failed = 0;
  for (const article of approved) {
    const result = await verifyArticle(article, { client, reviewerLogin, currentPr, headSha });
    console.log(`${result.ok ? "OK   " : "ERROR"} ${article.meta.slug}: ${result.reason}`);
    if (!result.ok) failed++;
  }
  if (!approved.length) console.log("Sin artículos aprobados: nada que verificar.");
  process.exit(failed ? 1 : 0);
}
