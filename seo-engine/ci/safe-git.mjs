// Acceso de SOLO LECTURA a un repositorio git para verificar un PR no confiable.
//
// Principios:
//  - El contenido del PR se lee como OBJETOS de git (por SHA de blob), nunca se extrae el árbol completo al disco ni se
//    ejecuta: no hay hooks, filtros, `textconv`, diff externo ni `fsmonitor`, y las rutas nunca llegan a una shell.
//  - Todo se invoca con execFile (sin shell), con un entorno mínimo y sin configuración global ni del sistema.
//  - Las rutas y los SHA son datos: se validan antes de usarlos. Los ficheros que sí se materializan (solo rutas de datos
//    permitidas, ficheros regulares y con tope de tamaño) van a un directorio temporal, nunca al espacio de trabajo.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const SHA = /^[0-9a-f]{40}$/;
export const MAX_BLOB_BYTES = 1_000_000;
export const MAX_FILES = 400;

const baseEnv = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
});

export function git(repoDir, args, { input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-C", repoDir, ...args],
    { env: baseEnv(), input, maxBuffer, stdio: ["pipe", "pipe", "pipe"] }
  );
}

export const assertSha = (value, label) => {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} debe ser un SHA de 40 caracteres hexadecimales`);
  return value;
};

// Comprueba que el SHA existe y es un commit (sin interpretar nada más que un SHA completo).
export function assertCommit(repoDir, sha, label) {
  assertSha(sha, label);
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    throw new Error(`${label} no es un commit del repositorio`);
  }
  return sha;
}

// Trae la referencia del PR que publica GitHub (también para forks) y comprueba que sigue apuntando al SHA del evento:
// si el PR se actualizó mientras corría el job, se falla en lugar de verificar otra cosa.
export function fetchPullHead(repoDir, number, expectedSha) {
  if (!/^\d{1,9}$/.test(String(number))) throw new Error("PR_NUMBER debe ser un entero");
  const ref = `refs/remotes/pull/${number}`;
  git(repoDir, ["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${number}/head:${ref}`]);
  const tip = git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).toString().trim();
  if (tip !== expectedSha) throw new Error("el PR se actualizó durante la ejecución (HEAD_SHA ya no es la cabeza actual del PR)");
}

// Ficheros que cambia el PR respecto a su punto de partida (merge-base con la base), sin detección de renombrados:
// un renombrado cuenta como borrado + alta, de modo que las reglas de ruta se aplican a ambos extremos.
export function changedFiles(repoDir, base, head) {
  assertSha(base, "BASE_SHA");
  assertSha(head, "HEAD_SHA");
  const out = git(repoDir, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--raw", "-z", "--no-abbrev", `${base}...${head}`, "--"]).toString("utf8");
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/);
    if (!meta) throw new Error("salida de git diff inesperada");
    const [, oldMode, newMode, oldSha, newSha, status] = meta;
    files.push({ path: parts[i + 1], status, oldMode, newMode, oldSha, newSha });
  }
  return files;
}

const NULL_SHA = "0".repeat(40);

// Contenido de un blob por SHA (no por ruta), con tope de tamaño. null si el SHA es el nulo (no existe).
export function readBlob(repoDir, sha, { max = MAX_BLOB_BYTES } = {}) {
  assertSha(sha, "SHA de blob");
  if (sha === NULL_SHA) return null;
  const size = Number(git(repoDir, ["cat-file", "-s", sha]).toString().trim());
  if (!Number.isInteger(size) || size > max) throw new Error(`blob demasiado grande (${size} bytes; máximo ${max})`);
  return git(repoDir, ["cat-file", "blob", sha]);
}

export function listTree(repoDir, rev) {
  assertSha(rev, "revisión");
  const out = git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", rev]).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/);
      if (!match) throw new Error("salida de git ls-tree inesperada");
      return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
    });
}

// Extrae SOLO los ficheros regulares cuya ruta cumple `allow` a `destDir`. Devuelve { written, skipped }.
// `skipped` recoge todo lo que se descartó (enlaces simbólicos, submódulos, ejecutables, rutas peligrosas…), para que
// quien llama pueda fallar en lugar de ignorar en silencio.
export function materializeData(repoDir, rev, destDir, allow, { maxFiles = MAX_FILES, maxBytes = MAX_BLOB_BYTES } = {}) {
  const root = resolve(destDir);
  const written = [];
  const skipped = [];
  for (const entry of listTree(repoDir, rev)) {
    if (!allow(entry.path)) continue;
    const target = resolve(root, entry.path);
    const unsafe = entry.path.includes("\\") || entry.path.includes("\0") || entry.path.split("/").some((part) => part === ".." || part === "." || part === "") || !target.startsWith(root + sep);
    if (unsafe) skipped.push({ path: entry.path, reason: "ruta no segura" });
    else if (entry.mode !== "100644" || entry.type !== "blob") skipped.push({ path: entry.path, reason: `tipo de fichero no permitido (${entry.mode})` });
    else if (written.length >= maxFiles) skipped.push({ path: entry.path, reason: "demasiados ficheros" });
    else {
      let data;
      try {
        data = readBlob(repoDir, entry.sha, { max: maxBytes });
      } catch (error) {
        skipped.push({ path: entry.path, reason: error.message });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { flag: "wx", mode: 0o644 });
      written.push(entry.path);
    }
  }
  return { written, skipped };
}
