// Utilidades de prueba para los controles de CI: repositorios git temporales que simulan un PR (hostil o no) y ejecución
// de los scripts de CONFIANZA (los de este repositorio) contra ellos. No es un test: vive fuera de tests/*.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GIT_ENV = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_LITERAL_PATHSPECS: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

export function makeRepo(prefix = "lp-ci-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  // `changes`: ruta → texto | Buffer | null (borrar) | { symlink } | { exec } | { gitlink }
  const commit = (changes, message = "c") => {
    for (const [path, value] of Object.entries(changes)) {
      const full = join(dir, path);
      if (value === null) {
        rmSync(full, { force: true });
        git("rm", "-q", "--cached", "--ignore-unmatch", "--", path);
        continue;
      }
      if (value?.gitlink) {
        git("update-index", "--add", "--cacheinfo", `160000,${value.gitlink},${path}`);
        continue;
      }
      rmSync(full, { force: true });
      mkdirSync(dirname(full), { recursive: true });
      if (value?.symlink) symlinkSync(value.symlink, full);
      else writeFileSync(full, value?.exec ?? value, { mode: value?.exec ? 0o755 : 0o644 });
      git("add", "-f", "--", path);
    }
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, branch: (name, from) => git("checkout", "-q", "-B", name, from ?? "HEAD"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Ejecuta un script de confianza de ESTE repositorio contra el repositorio temporal (cwd neutro, entorno mínimo).
export function runTrusted(script, { repo, base, head, author = "otra-persona", branch = "feat/x", env = {}, summary, cwd } = {}) {
  const neutral = cwd ?? mkdtempSync(join(tmpdir(), "lp-cwd-"));
  const vars = { PATH: process.env.PATH, REPO_DIR: repo.dir, BASE_SHA: base, HEAD_SHA: head, PR_AUTHOR: author, PR_BRANCH: branch, ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}), ...env };
  for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key];
  const result = spawnSync("node", [join(ROOT, "seo-engine/ci", script)], { cwd: neutral, env: vars, encoding: "utf8", timeout: 60_000 });
  rmSync(neutral, { recursive: true, force: true });
  return result;
}

// Comprueba que la salida no permite inyectar comandos de workflow ni caracteres de control.
export function outputProblems(stdout) {
  const problems = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("::") && !/^::(error|warning|notice)( title=[^:,\n]*)?::[^\n]*$/.test(line)) problems.push(`comando de workflow no esperado: ${line.slice(0, 80)}`);
    if (/^::(set-output|set-env|add-mask|add-path|stop-commands|save-state|debug|group|endgroup)/.test(line)) problems.push(`comando de workflow inyectado: ${line.slice(0, 80)}`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‮⁦]/.test(line)) problems.push("carácter de control en la salida");
  }
  return problems;
}

export const exists = (path) => existsSync(path);
