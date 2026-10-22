// Lectura segura de objetos de git (seo-engine/ci/safe-git.mjs): el PR es un conjunto de objetos, nunca código.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BLOB_BYTES, assertCommit, assertSha, changedFiles, materializeData, readBlob } from "../seo-engine/ci/safe-git.mjs";
import { makeRepo } from "./helpers/ci-repo.mjs";

const allowMd = (p) => /^content\/blog\/[a-z0-9-]+\.md$/.test(p);

test("assertSha solo acepta 40 hex en minúscula, sin espacios ni opciones", () => {
  assert.equal(assertSha("a".repeat(40), "X"), "a".repeat(40));
  for (const bad of ["", "A".repeat(40), "a".repeat(39), "a".repeat(41), "-h", "--output=x", `${"a".repeat(40)}\n`, " " + "a".repeat(40), "HEAD", undefined, null, 5, "../x"]) {
    assert.throws(() => assertSha(bad, "X"), /X/, String(bad));
  }
});

test("assertCommit exige un commit que existe en el repositorio (no un árbol ni un blob ni un objeto inexistente)", () => {
  const repo = makeRepo();
  const c = repo.commit({ "content/blog/a.md": "x" });
  const tree = repo.git("rev-parse", `${c}^{tree}`);
  const blob = repo.git("rev-parse", `${c}:content/blog/a.md`);
  assert.doesNotThrow(() => assertCommit(repo.dir, c, "HEAD_SHA"));
  for (const sha of [tree, blob, "1".repeat(40)]) assert.throws(() => assertCommit(repo.dir, sha, "HEAD_SHA"), /HEAD_SHA/);
  repo.cleanup();
});

test("changedFiles informa de modos y rutas exactas (incluso con saltos de línea), sin detectar renombrados", () => {
  const repo = makeRepo();
  const base = repo.commit({ "README.md": "m" });
  repo.branch("pr");
  const odd = "content/blog/x\ny.md";
  const head = repo.commit({ [odd]: "a", "content/blog/ok.md": { exec: "b" }, "content/blog/link.md": { symlink: "README.md" }, "README.md": null });
  const files = changedFiles(repo.dir, base, head);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath[odd].newMode, "100644");
  assert.equal(byPath["content/blog/ok.md"].newMode, "100755");
  assert.equal(byPath["content/blog/link.md"].newMode, "120000");
  assert.equal(byPath["README.md"].newMode, "000000");
  repo.cleanup();
});

test("readBlob lee por SHA, respeta el tope de tamaño y rechaza no-blobs", () => {
  const repo = makeRepo();
  const c = repo.commit({ "small.md": "hola", "big.md": "x".repeat(MAX_BLOB_BYTES + 10) });
  const small = repo.git("rev-parse", `${c}:small.md`);
  const big = repo.git("rev-parse", `${c}:big.md`);
  assert.equal(readBlob(repo.dir, small).toString(), "hola");
  assert.throws(() => readBlob(repo.dir, big), /tamañ|grande|límite/i);
  assert.throws(() => readBlob(repo.dir, repo.git("rev-parse", `${c}^{tree}`)), /./);
  assert.throws(() => readBlob(repo.dir, "--help"), /./);
  repo.cleanup();
});

test("materializeData escribe solo ficheros regulares permitidos y omite el resto con motivo (nunca enlaces ni ejecutables)", () => {
  const repo = makeRepo();
  repo.commit({
    "content/blog/ok.md": "ok",
    "content/blog/exec.md": { exec: "x" },
    "content/blog/link.md": { symlink: "/etc/passwd" },
    "content/blog/sub.md": { gitlink: "2".repeat(40) },
    "seo-engine/ci/evil.mjs": "process.exit(0)",
    "content/blog/../../escape.md": "x",
  });
  const head = repo.git("rev-parse", "HEAD");
  const dest = mkdtempSync(join(tmpdir(), "lp-mat-"));
  const { written, skipped } = materializeData(repo.dir, head, dest, allowMd);
  assert.deepEqual(written, ["content/blog/ok.md"]);
  assert.equal(readFileSync(join(dest, "content/blog/ok.md"), "utf8"), "ok");
  const names = skipped.map((s) => s.path).sort();
  assert.deepEqual(names, ["content/blog/exec.md", "content/blog/link.md", "content/blog/sub.md"]);
  assert.ok(!existsSync(join(dest, "seo-engine")), "las rutas no permitidas ni se extraen");
  assert.ok(!lstatSync(join(dest, "content/blog/ok.md")).isSymbolicLink());
  assert.deepEqual(readdirSync(join(dest, "content/blog")), ["ok.md"]);
  rmSync(dest, { recursive: true, force: true });
  repo.cleanup();
});
