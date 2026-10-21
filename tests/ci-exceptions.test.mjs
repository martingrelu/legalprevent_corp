// Excepciones firmadas dentro del control `sources-live` de CI: los registros llegan del PR (datos), pero la clave sale de la
// rama base (código de confianza) y la huella de la variable fijada fuera del repositorio. `fetch` devuelve 503 siempre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource } from "../seo-engine/blog-render.mjs";
import { bindingFor, lockCutoff } from "../seo-engine/sources/exceptions.mjs";
import { DAY, IDENTITY, genKey, insst, iso, registry, signedRecord, webLockAt, articleWith } from "./helpers/exceptions-fixture.mjs";
import { ROOT, makeRepo, outputProblems, runTrusted } from "./helpers/ci-repo.mjs";

const dir = mkdtempSync(join(tmpdir(), "lp-exci-"));
const preload = join(dir, "down.mjs");
writeFileSync(preload, `globalThis.fetch = async () => new Response("error", { status: 503 });\n`);
const registryText = JSON.stringify(registry);
const lock = await webLockAt(insst, new Date());
const art = articleWith([{ id: "g1", source: insst.id, type: "criterio", locator: { section: "Resumen" }, lock }], { approved_at: new Date().toISOString().slice(0, 10) });
const articleText = `---\n${JSON.stringify(art.meta)}\n---\n${art.body}`;
const parsed = parseSource(articleText, "tema.md");
const binding = bindingFor({ meta: parsed.meta, body: parsed.body, citation: parsed.meta.citations[0], entry: insst });

// Copia del código de confianza (la rama base) con o sin allowed_signers.
function trustedRoot(key) {
  const root = mkdtempSync(join(dir, "trusted-"));
  cpSync(join(ROOT, "seo-engine"), join(root, "seo-engine"), { recursive: true });
  rmSync(join(root, "seo-engine/allowed_signers"), { force: true });
  if (key) writeFileSync(join(root, "seo-engine/allowed_signers"), key.allowedSigners);
  return root;
}
const now = Date.now();
const record = (key, patch = {}) => signedRecord({ binding, issued_at: iso(Math.max(now - 60_000, Date.parse(`${lock.verified_at}T00:00:00Z`))), expires_at: iso(Math.min(now + 5 * DAY, lockCutoff(lock) - 1000)), key, ...patch });

function run({ files = {}, root, fingerprint, author = "martingrelu", branch = "feat/x", script = "check-sources-live.mjs" }) {
  const repo = makeRepo();
  const base = repo.commit({ "README.md": "m\n" }, "base");
  repo.branch("pr");
  const head = repo.commit(files, "pr");
  const r = runTrusted(script, { repo, base, head, author, branch, trustedRoot: root, env: { NODE_OPTIONS: `--import=${preload}`, LIVE_ATTEMPTS: "1", ...(fingerprint ? { BLOG_APPROVER_FINGERPRINT: fingerprint } : {}) } });
  repo.cleanup();
  return r;
}
const prFiles = (rec, extra = {}) => ({ "content/blog/tema.md": articleText, "content/sources/registry.json": registryText, [`content/blog/exceptions/tema/${rec.file}`]: `${JSON.stringify(rec.record, null, 2)}\n`, ...extra });

test("excepción válida del responsable + clave de la rama base + huella fijada: REVISION_EXCEPCIONAL y el job pasa con aviso", () => {
  const key = genKey("approver");
  const r = run({ files: prFiles(record(key)), root: trustedRoot(key), fingerprint: key.fingerprint });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /REVISION_EXCEPCIONAL/);
  assert.match(r.stdout, /NO verificada/);
  assert.doesNotMatch(r.stdout, /CONFIRMED|VERIFIED/);
  assert.match(r.stdout, /^::warning /m);
  assert.deepEqual(outputProblems(r.stdout), []);
});

test("el PR intenta sustituir la clave (allowed_signers propio) y firmar su propia excepción: se usa la de la rama base y falla", () => {
  const real = genKey("approver");
  const attacker = genKey("attacker");
  const files = prFiles(record(attacker), { "seo-engine/allowed_signers": attacker.allowedSigners });
  const r = run({ files, root: trustedRoot(real), fingerprint: real.fingerprint });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /UNREACHABLE/);
  assert.doesNotMatch(r.stdout, /REVISION_EXCEPCIONAL/);
  // Aunque el atacante controle también la huella que ve su propio PR, la variable la fija el repositorio, no el PR.
  const r2 = run({ files, root: trustedRoot(real), fingerprint: attacker.fingerprint });
  assert.equal(r2.status, 1, "huella del atacante no coincide con la clave de la rama base");
});

test("sin huella fijada, o sin allowed_signers en la rama base, no hay excepciones (falla cerrado)", () => {
  const key = genKey("approver");
  const noFp = run({ files: prFiles(record(key)), root: trustedRoot(key) });
  assert.equal(noFp.status, 1, noFp.stdout);
  assert.match(noFp.stdout, /no disponibles/);
  const noKey = run({ files: prFiles(record(key)), root: trustedRoot(null), fingerprint: key.fingerprint });
  assert.equal(noKey.status, 1, noKey.stdout);
  assert.match(noKey.stdout, /no disponibles/);
});

test("excepción firmada con otra clave o por otra identidad, o caducada: el job falla", () => {
  const key = genKey("approver");
  const other = genKey("other");
  assert.equal(run({ files: prFiles(record(other)), root: trustedRoot(key), fingerprint: key.fingerprint }).status, 1);
  assert.equal(run({ files: prFiles(record(key, { identity: "alguien" })), root: trustedRoot(key), fingerprint: key.fingerprint }).status, 1);
  const expired = record(key, { issued_at: iso(Date.parse(`${lock.verified_at}T00:00:00Z`)), expires_at: iso(Date.parse(`${lock.verified_at}T00:00:00Z`) + 1000) });
  assert.equal(run({ files: prFiles(expired), root: trustedRoot(key), fingerprint: key.fingerprint }).status, 1);
});

test("un PR generado no puede añadir excepciones (separation), y los ficheros de excepciones con nombres hostiles no se leen", () => {
  const key = genKey("approver");
  const files = prFiles(record(key));
  const sep = run({ files, author: "legalprevent-seo-bot", branch: "seo/x", script: "check-separation.mjs", root: trustedRoot(key) });
  assert.equal(sep.status, 1, sep.stdout);
  assert.match(sep.stdout, /content\/blog\/exceptions\//);
  const hostile = run({ files: { ...prFiles(record(key)), "content/blog/exceptions/tema/..%2f..%2fx.json": "{}", "content/blog/exceptions/tema/evil.json": "{}" }, root: trustedRoot(key), fingerprint: key.fingerprint });
  assert.equal(hostile.status, 0, "los ficheros que no cumplen el patrón de nombre no se extraen ni se evalúan");
  assert.deepEqual(outputProblems(hostile.stdout), []);
});

test("el workflow pasa la huella solo a sources-live", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(join(ROOT, ".github/workflows/blog-trust.yml"), "utf8").replace(/^\s*#.*$/gm, "");
  const blocks = text.split(/^  (?=[a-z-]+:\n)/m);
  const withFp = blocks.filter((b) => /BLOG_APPROVER_FINGERPRINT/.test(b)).map((b) => b.split(":")[0]);
  assert.deepEqual(withFp, ["sources-live"]);
  assert.match(text, /BLOG_APPROVER_FINGERPRINT: \$\{\{ vars\.BLOG_APPROVER_FINGERPRINT \}\}/);
  assert.doesNotMatch(text, /secrets\./);
});
