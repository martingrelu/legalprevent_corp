// Control `sources-live`: comprueba EN VIVO (solo lectura, solo www.boe.es / www.aepd.es / www.insst.es) las citas de los
// artículos aprobados que el PR añade o modifica, y de los que citan una fuente cuya entrada del registro cambia en el PR.
// Se ejecuta con el código de la rama base; el PR se lee como datos (ver check-citations.mjs). Modo estricto por defecto.
//
// Variables: las de check-separation + LIVE_MODE=strict|informative (por defecto strict) y LIVE_ATTEMPTS (1..5, por defecto 3).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource } from "../blog-render.mjs";
import { TRUSTED_ROOT, humanLogin, readContext, runCheck } from "./common.mjs";
import { assertCommit, changedFiles, fetchPullHead, materializeData } from "./safe-git.mjs";
import { safeText } from "./sanitize.mjs";
import { createBoeClient } from "../sources/adapters/boe.mjs";
import { createWebClient } from "../sources/adapters/web.mjs";
import { HOSTS, assertRegistry, registryEntryHash, urlProblem } from "../sources/schema.mjs";
import { ARTICLE_PATH } from "../sources/separation.mjs";
import { MODES, formatLiveItem, liveCheckArticle } from "../sources/live-check.mjs";
import { loadRecords } from "../sources/exceptions.mjs";

const REGISTRY_PATH = "content/sources/registry.json";
const EXCEPTION_PATH = /^content\/blog\/exceptions\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{8}T\d{6}Z-(?:grant|revoke)-[0-9a-f]{8}\.json$/;
const allowed = (path) => ARTICLE_PATH.test(path) || path === REGISTRY_PATH || EXCEPTION_PATH.test(path);
const MAX_CITATIONS = 40; // presupuesto de tiempo del job; superarlo FALLA (nunca se omite en silencio)

function liveContext(env = process.env) {
  const mode = env.LIVE_MODE ?? "strict";
  if (!MODES.includes(mode)) throw new Error(`LIVE_MODE inválido: ${safeText(mode, 40)}`);
  const attempts = env.LIVE_ATTEMPTS === undefined ? 3 : Number(env.LIVE_ATTEMPTS);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("LIVE_ATTEMPTS debe ser un entero entre 1 y 5");
  return { mode, attempts };
}

function readRegistry(repoDir, rev, dir) {
  const { written } = materializeData(repoDir, rev, dir, (path) => path === REGISTRY_PATH);
  return written.includes(REGISTRY_PATH) ? assertRegistry(JSON.parse(readFileSync(join(dir, REGISTRY_PATH), "utf8"))) : null;
}

// Se ejecuta SIEMPRE al cargar el script (como los demás controles): una comprobación de "soy el programa principal" podía
// dejar el job en verde sin comprobar nada si la ruta se resolvía distinto (enlaces simbólicos).
{
  runCheck("sources-live", async (report) => {
    const ctx = readContext();
    const { mode, attempts } = liveContext();
    if (ctx.fetchPr) fetchPullHead(ctx.repoDir, ctx.number, ctx.head);
    assertCommit(ctx.repoDir, ctx.base, "BASE_SHA");
    assertCommit(ctx.repoDir, ctx.head, "HEAD_SHA");
    const files = changedFiles(ctx.repoDir, ctx.base, ctx.head);
    const touched = new Set(files.filter((f) => ARTICLE_PATH.test(f.path) && f.newMode !== "000000").map((f) => f.path));

    const headDir = mkdtempSync(join(tmpdir(), "lp-live-head-"));
    const baseDir = mkdtempSync(join(tmpdir(), "lp-live-base-"));
    try {
      const { written, skipped } = materializeData(ctx.repoDir, ctx.head, headDir, allowed);
      for (const item of skipped) report.problem(`${safeText(item.path)}: no se puede leer como dato (${safeText(item.reason)})`);
      const articles = [];
      for (const path of written.filter((p) => ARTICLE_PATH.test(p))) {
        const { meta, body } = parseSource(readFileSync(join(headDir, path), "utf8"), path);
        if (path !== `content/blog/${meta.slug}.md`) throw new Error(`${path}: el nombre del fichero no coincide con el slug`);
        articles.push({ path, meta, body });
      }
      for (const path of touched) if (!written.includes(path)) report.problem(`${safeText(path)}: el PR lo toca y no se ha podido analizar`);

      const approved = articles.filter(({ meta }) => meta.review_status === "approved");
      if (!approved.length) {
        report.info("Sin artículos aprobados: nada que comprobar en vivo.");
        return;
      }
      if (!written.includes(REGISTRY_PATH)) throw new Error(`falta ${REGISTRY_PATH} y hay artículos aprobados`);
      const registry = assertRegistry(JSON.parse(readFileSync(join(headDir, REGISTRY_PATH), "utf8")));
      const baseRegistry = readRegistry(ctx.repoDir, ctx.base, baseDir);
      const baseHash = new Map((baseRegistry?.sources ?? []).map((entry) => [entry.id, registryEntryHash(entry)]));
      const changedSources = new Set(registry.sources.filter((entry) => baseHash.get(entry.id) !== registryEntryHash(entry)).map((entry) => entry.id));

      // Alcance: artículos aprobados tocados por el PR o que citan una fuente nueva/modificada en el PR.
      const scope = approved.filter(({ path, meta }) => touched.has(path) || (meta.citations ?? []).some((c) => changedSources.has(c?.source)));
      report.info(`Modo ${mode}; hasta ${attempts} intentos por cita transitoria. Aprobados: ${approved.length}; en alcance: ${scope.length}; fuentes nuevas o modificadas: ${changedSources.size}.`);
      report.row(["modo", mode]);
      report.row(["artículos en alcance", String(scope.length)]);
      const total = scope.reduce((sum, { meta }) => sum + (Array.isArray(meta.citations) ? meta.citations.length : 0), 0);
      if (total > MAX_CITATIONS) throw new Error(`demasiadas citas para una ejecución (${total} > ${MAX_CITATIONS}): divide el PR`);

      // Defensa en profundidad: el registro ya valida los anfitriones, pero aquí se exige otra vez antes de salir a la red.
      for (const entry of registry.sources) {
        for (const url of Object.values(entry.urls ?? {})) if (urlProblem(url, entry.authority)) throw new Error(`${safeText(entry.id)}: URL no permitida`);
        if (!HOSTS[entry.authority]) throw new Error(`${safeText(entry.id)}: autoridad desconocida`);
      }

      // Excepciones firmadas (F2.3c): los registros salen del PR (datos); la CLAVE sale de la rama base (código de confianza) y su
      // huella de la variable de Actions fijada fuera del repositorio. Sin cualquiera de las dos, no hay excepciones.
      const signersPath = join(TRUSTED_ROOT, "seo-engine/allowed_signers");
      const pinned = process.env.BLOG_APPROVER_FINGERPRINT ?? "";
      const exceptions = existsSync(signersPath) && pinned
        ? { recordsFor: (slug) => loadRecords(join(headDir, "content/blog/exceptions"), slug), allowedSigners: readFileSync(signersPath, "utf8"), identity: humanLogin(), pinnedFingerprint: pinned }
        : undefined;
      report.row(["excepciones firmadas", exceptions ? "disponibles" : "no disponibles (falta allowed_signers de la base o la huella fijada)"]);
      report.info(exceptions ? "Excepciones firmadas: disponibles (clave de la rama base, huella fijada)." : "Excepciones firmadas: no disponibles (falta allowed_signers de la rama base o la huella fijada): ninguna excepción se aplica.");

      const boe = createBoeClient();
      const web = createWebClient();
      for (const article of scope) {
        const result = await liveCheckArticle(article, registry, { boe, web, retry: { attempts }, mode, exceptions });
        report.row([article.meta.slug, result.blocking ? "BLOQUEA" : "ok"]);
        for (const item of result.items) {
          if (item.outcome === "exceptional_review") report.warn(`${safeText(article.meta.slug)}: ${safeText(formatLiveItem(item), 260)}`);
          else if (item.outcome === "confirmed") report.info(`${article.meta.slug}: ${formatLiveItem(item)}`);
          else if (item.blocking) report.problem(`${safeText(article.meta.slug)}: ${safeText(formatLiveItem(item), 260)}`);
          else report.warn(`${safeText(article.meta.slug)}: ${safeText(formatLiveItem(item), 260)} (modo informativo: NO verificado)`);
        }
      }
    } finally {
      rmSync(headDir, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
}
