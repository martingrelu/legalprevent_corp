// Control `citations` (offline, sin red): verifica las citas de todos los artículos APROBADOS del PR contra el registro de
// fuentes. Se ejecuta con el código de la rama base; los artículos y el registro del PR se leen como DATOS desde git y se
// extraen solo ficheros regulares de rutas permitidas a un directorio temporal. Nunca se ejecuta nada del PR.
//
// Falla cerrado ante: ficheros de artículo que no se pueden leer o que no son regulares, front matter inválido, registro
// ausente o inválido, nombre de fichero distinto del slug, o un PR que toca artículos y analiza menos de los que toca.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource } from "../blog-render.mjs";
import { readContext, runCheck } from "./common.mjs";
import { assertCommit, changedFiles, fetchPullHead, materializeData } from "./safe-git.mjs";
import { safeText } from "./sanitize.mjs";
import { formatItem, loadRegistry, verifyArticleCitations } from "../sources/verify-citations.mjs";
import { ARTICLE_PATH } from "../sources/separation.mjs";

const REGISTRY_PATH = "content/sources/registry.json";
const allowed = (path) => ARTICLE_PATH.test(path) || path === REGISTRY_PATH;
const MAX_ITEMS = 60;

runCheck("citations", (report) => {
  const ctx = readContext();
  if (ctx.fetchPr) fetchPullHead(ctx.repoDir, ctx.number, ctx.head);
  assertCommit(ctx.repoDir, ctx.base, "BASE_SHA");
  assertCommit(ctx.repoDir, ctx.head, "HEAD_SHA");
  const files = changedFiles(ctx.repoDir, ctx.base, ctx.head);
  const touched = files.filter((file) => ARTICLE_PATH.test(file.path) && file.newMode !== "000000");

  const dir = mkdtempSync(join(tmpdir(), "lp-citations-"));
  try {
    const { written, skipped } = materializeData(ctx.repoDir, ctx.head, dir, allowed);
    for (const item of skipped) report.problem(`${safeText(item.path)}: no se puede leer como dato (${safeText(item.reason)})`);

    const articleFiles = written.filter((path) => ARTICLE_PATH.test(path));
    const articles = [];
    for (const path of articleFiles) {
      const { meta, body } = parseSource(readFileSync(join(dir, path), "utf8"), path);
      if (path !== `content/blog/${meta.slug}.md`) throw new Error(`${path}: el nombre del fichero no coincide con el slug`);
      articles.push({ meta, body });
    }

    // Guardia contra el éxito silencioso: todo artículo que toca el PR tiene que haberse leído y analizado.
    const analysed = new Set(articleFiles);
    for (const file of touched) {
      if (!analysed.has(file.path)) report.problem(`${safeText(file.path)}: el PR lo toca y no se ha podido analizar`);
    }
    if (touched.length && articles.length === 0) report.problem("el PR toca artículos y no se ha analizado ninguno");

    const approved = articles.filter(({ meta }) => meta.review_status === "approved");
    report.info(`Artículos leídos: ${articles.length}; aprobados: ${approved.length}; tocados por el PR: ${touched.length}.`);
    report.row(["artículos leídos", String(articles.length)]);
    report.row(["aprobados", String(approved.length)]);
    if (!approved.length) {
      report.info("Sin artículos aprobados: nada que verificar.");
      return;
    }
    if (!written.includes(REGISTRY_PATH)) throw new Error(`falta ${REGISTRY_PATH} y hay artículos aprobados`);
    const registry = loadRegistry(join(dir, REGISTRY_PATH));

    let shown = 0;
    for (const article of approved) {
      const result = verifyArticleCitations(article, registry);
      report.row([article.meta.slug, result.blocking ? "BLOQUEA" : "ok"]);
      if (result.blocking) report.problem(`artículo ${article.meta.slug}: sus citas bloquean la publicación`);
      for (const item of result.items) {
        if (!item.blocking || shown >= MAX_ITEMS) continue;
        shown++;
        report.info(`${article.meta.slug}: ${formatItem(item)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
