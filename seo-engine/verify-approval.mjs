// Verifica que cada artículo aprobado tiene una aprobación REAL de la PR, no solo un campo de texto.
//
// Mecanismo (trazabilidad):
//   1. El borrador se revisa en una PR. El responsable jurídico la aprueba con una revisión de
//      GitHub ("Approve") sobre el commit C, que contiene el artículo con review_status "in_review".
//   2. Un commit posterior añade al artículo review_status "approved", approved_at y el bloque
//      approval { pr, commit: C, content_sha256 }. Esos campos NO forman parte del hash de contenido.
//   3. Este verificador comprueba, contra la API de GitHub y el historial de git, que:
//        - existe una revisión APPROVED del responsable (seo-engine/approvers.json) en la PR indicada;
//        - es su última revisión (una posterior de "cambios solicitados" o "descartada" la anula);
//        - se hizo sobre el commit approval.commit;
//        - el contenido del artículo en ese commit tiene el mismo hash que el actual,
//          es decir, nada cambió después de la aprobación.
//
// Uso (solo lectura; necesita GITHUB_TOKEN con permiso de lectura de PR):
//   GITHUB_REPOSITORY=martingrelu/legalprevent_corp node seo-engine/verify-approval.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, loadArticles, parseRaw } from "./blog-render.mjs";

const DECISIVE = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

// Función pura: recibe las revisiones de la PR y el hash del contenido en el commit aprobado.
export function verifyApprovalRecord({ meta }, reviews, reviewerLogin, hashAtApprovedCommit) {
  const approval = meta.approval;
  if (meta.review_status !== "approved" || !approval) return { ok: false, reason: "el artículo no está aprobado" };
  const decisive = reviews.filter(
    (review) => review.user?.login?.toLowerCase() === reviewerLogin.toLowerCase() && DECISIVE.includes(review.state)
  );
  const latest = decisive.at(-1);
  if (!latest) return { ok: false, reason: `${reviewerLogin} no ha revisado la PR #${approval.pr}` };
  if (latest.state !== "APPROVED") return { ok: false, reason: `la última revisión de ${reviewerLogin} es ${latest.state}` };
  if (latest.commit_id !== approval.commit) {
    return { ok: false, reason: "la aprobación de la PR es de otro commit distinto de approval.commit" };
  }
  if (hashAtApprovedCommit !== approval.content_sha256) {
    return { ok: false, reason: "el contenido en approval.commit no coincide con approval.content_sha256" };
  }
  return { ok: true, reason: `aprobado por ${reviewerLogin} en la PR #${approval.pr}` };
}

async function fetchReviews(repo, pr, token) {
  const reviews = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} al leer las revisiones de la PR #${pr}`);
    const batch = await response.json();
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { reviewer_github: reviewer } = JSON.parse(readFileSync(resolve(root, "seo-engine/approvers.json"), "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("Faltan GITHUB_REPOSITORY o GITHUB_TOKEN");
    process.exit(2);
  }
  let failed = 0;
  for (const article of loadArticles(resolve(root, "content/blog")).filter(({ meta }) => meta.review_status === "approved")) {
    const { slug, approval } = article.meta;
    let result;
    try {
      const old = execFileSync("git", ["show", `${approval.commit}:content/blog/${slug}.md`], { cwd: root, encoding: "utf8" });
      const { meta, body } = parseRaw(old, `${slug}@${approval.commit.slice(0, 7)}`);
      result = verifyApprovalRecord(article, await fetchReviews(repo, approval.pr, token), reviewer, contentHash(meta, body));
    } catch (error) {
      result = { ok: false, reason: error.message };
    }
    console.log(`${result.ok ? "OK " : "ERROR"} ${slug}: ${result.reason}`);
    if (!result.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}
