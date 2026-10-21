// Utilidades comunes de los controles de confianza del CI (F2.3a). Estos scripts se ejecutan SIEMPRE desde el código de la
// rama base (el que está en el directorio de trabajo del job); el contenido del PR solo se lee como datos desde git.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { annotation, markdownCode, safeText } from "./sanitize.mjs";
import { assertSha } from "./safe-git.mjs";

// Raíz del código de confianza: el directorio de este fichero, nunca el repositorio que se está verificando.
export const TRUSTED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// El responsable humano sale de la configuración de confianza (rama base), no de la del PR.
export const humanLogin = () => JSON.parse(readFileSync(resolve(TRUSTED_ROOT, "seo-engine/approvers.json"), "utf8")).reviewer_github;

// Entrada del job. Todo son datos no confiables: se validan y nunca se interpolan en una shell.
export function readContext(env = process.env) {
  const repoDir = resolve(env.REPO_DIR || process.cwd());
  const base = assertSha(env.BASE_SHA, "BASE_SHA");
  const head = assertSha(env.HEAD_SHA, "HEAD_SHA");
  const author = typeof env.PR_AUTHOR === "string" ? env.PR_AUTHOR : "";
  const branch = typeof env.PR_BRANCH === "string" ? env.PR_BRANCH : "";
  const fetchPr = env.FETCH_PR === "1";
  const number = env.PR_NUMBER;
  if (fetchPr && !/^\d{1,9}$/.test(String(number ?? ""))) throw new Error("PR_NUMBER debe ser un entero cuando FETCH_PR=1");
  return { repoDir, base, head, author, branch, fetchPr, number };
}

export class Report {
  constructor(title, env = process.env) {
    this.title = title;
    this.lines = [];
    this.rows = [];
    this.failed = false;
    this.summaryPath = env.GITHUB_STEP_SUMMARY || null;
  }
  info(text) {
    this.lines.push(`  ${safeText(text, 300)}`);
  }
  row(cells) {
    this.rows.push(cells);
  }
  problem(text) {
    this.failed = true;
    this.lines.push(annotation("error", text, this.title));
  }
  warn(text) {
    this.lines.push(annotation("warning", text, this.title));
  }
  flush(verdict) {
    console.log(`${this.title}: ${verdict}`);
    for (const line of this.lines) console.log(line);
    if (this.summaryPath) {
      const table = this.rows.length ? `\n| Elemento | Resultado |\n|---|---|\n${this.rows.map(([a, b]) => `| ${markdownCode(a)} | ${safeText(b, 200).replace(/\|/g, "ˋ")} |`).join("\n")}\n` : "";
      appendFileSync(this.summaryPath, `### ${safeText(this.title)}: ${safeText(verdict)}\n${this.lines.filter((l) => !l.startsWith("::")).map((l) => `- ${l.trim()}`).join("\n")}\n${table}\n`);
    }
  }
}

// Ejecuta un control. Cualquier excepción es un FALLO (falla cerrado): nunca un éxito silencioso.
export async function runCheck(title, check) {
  const report = new Report(title);
  try {
    await check(report);
    report.flush(report.failed ? "FALLO" : "CORRECTO");
    process.exit(report.failed ? 1 : 0);
  } catch (error) {
    report.problem(`error interno o entrada inválida: ${error?.message ?? error}`);
    report.flush("FALLO (falla cerrado)");
    process.exit(1);
  }
}
