// Control `separation`: comprueba que un PR de origen "generador" (cualquier autor que no sea el responsable) solo
// toca su propio borrador. Se ejecuta con el código de la rama base; el PR se lee como objetos de git.
//
// Variables: REPO_DIR (por defecto, el directorio actual), BASE_SHA, HEAD_SHA, PR_AUTHOR, PR_BRANCH,
// FETCH_PR=1 + PR_NUMBER (en el CI: trae refs/pull/<n>/head y comprueba que sigue siendo HEAD_SHA).
import { humanLogin, readContext, runCheck } from "./common.mjs";
import { assertCommit, changedFiles, fetchPullHead, readBlob } from "./safe-git.mjs";
import { ARTICLE_PATH, originOf, separationProblems } from "../sources/separation.mjs";
import { safeText } from "./sanitize.mjs";

const MAX_PROBLEMS = 40;
const NULL_SHA = "0".repeat(40);

runCheck("separation", (report) => {
  const ctx = readContext();
  if (ctx.fetchPr) fetchPullHead(ctx.repoDir, ctx.number, ctx.head);
  assertCommit(ctx.repoDir, ctx.base, "BASE_SHA");
  assertCommit(ctx.repoDir, ctx.head, "HEAD_SHA");

  const origin = originOf({ author: ctx.author, humanLogin: humanLogin(), branch: ctx.branch });
  const files = changedFiles(ctx.repoDir, ctx.base, ctx.head);
  report.info(`Origen: ${origin} (decidido por el autor del PR, no por la rama ni por los commits). Ficheros cambiados: ${files.length}.`);
  report.row(["origen", origin]);
  report.row(["ficheros cambiados", String(files.length)]);

  if (origin === "human") {
    report.info("Autor humano: sin restricciones de ruta en este control. La publicación sigue exigiendo la firma del responsable.");
    return;
  }

  const text = (sha) => (sha === NULL_SHA ? null : readBlob(ctx.repoDir, sha).toString("utf8"));
  const changes = files.map((file) => {
    const article = ARTICLE_PATH.test(file.path);
    const deleted = file.newSha === NULL_SHA;
    return {
      path: file.path,
      mode: deleted ? undefined : file.newMode,
      before: article ? text(file.oldSha) : null,
      after: deleted ? null : article ? text(file.newSha) : "",
    };
  });
  const problems = separationProblems({ origin, changes });
  for (const problem of problems.slice(0, MAX_PROBLEMS)) report.problem(safeText(problem, 300));
  if (problems.length > MAX_PROBLEMS) report.problem(`…y ${problems.length - MAX_PROBLEMS} problemas más`);
  report.row(["problemas de separación", String(problems.length)]);
  if (!problems.length) report.info("El PR generado solo toca su propio borrador en draft o in_review.");
});
