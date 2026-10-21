// Casos ADVERSOS de los controles de confianza (F2.3a): un PR hostil intenta modificar o desactivar los propios
// verificadores, ejecutar código, inyectar comandos en el log o colarse con ficheros especiales. Cada caso construye un
// repositorio git temporal (el "PR") y ejecuta los scripts de CONFIANZA de este repositorio contra él.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, outputProblems, runTrusted } from "./helpers/ci-repo.mjs";

const article = (meta = {}, body = "Texto.") =>
  `---\n${JSON.stringify({ slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "draft", ...meta })}\n---\n${body}`;
const GEN = { author: "legalprevent-seo-bot", branch: "seo/tema" };

// Base con contenido de confianza mínimo y una rama de PR a partir de ella.
function scenario(prChanges, { baseChanges = { "README.md": "base\n" } } = {}) {
  const repo = makeRepo();
  const base = repo.commit(baseChanges, "base");
  repo.branch("pr");
  const head = repo.commit(prChanges, "pr");
  return { repo, base, head };
}
const sentinelDir = () => mkdtempSync(join(tmpdir(), "lp-sentinel-"));
const run = (script, s, extra = {}) => runTrusted(script, { repo: s.repo, base: s.base, head: s.head, ...GEN, ...extra });

test("un PR generado que solo añade su borrador pasa; el mismo PR del responsable pasa sin restricciones de ruta", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const r = run("check-separation.mjs", s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const human = run("check-separation.mjs", s, { author: "martingrelu", branch: "feat/x" });
  assert.equal(human.status, 0, human.stdout);
  assert.match(human.stdout, /Origen: human/);
  s.repo.cleanup();
});

test("el PR modifica los verificadores, el workflow y la configuración de confianza: se rechaza (generado) y NO se ejecuta nada", () => {
  const sentinel = sentinelDir();
  const payload = (name) => `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(sentinel, name))}, "ejecutado");\nprocess.exit(0);\n`;
  const s = scenario({
    "seo-engine/ci/check-separation.mjs": payload("separation"),
    "seo-engine/ci/check-citations.mjs": payload("citations"),
    "seo-engine/ci/sanitize.mjs": payload("sanitize"),
    "seo-engine/ci/safe-git.mjs": payload("safe-git"),
    "seo-engine/sources/separation.mjs": payload("separation-lib"),
    "seo-engine/approvers.json": JSON.stringify({ reviewer_github: "legalprevent-seo-bot", mode: "signature" }),
    "seo-engine/allowed_signers": "atacante ssh-ed25519 AAAA\n",
    ".github/workflows/blog-trust.yml": "name: x\non: push\njobs: {}\n",
    ".github/workflows/blog-ci.yml": "name: x\non: push\njobs: {}\n",
    "package.json": JSON.stringify({ scripts: { postinstall: `node ${join(sentinel, "x.js")}` } }),
    ".npmrc": "node-options=--require=/tmp/x\n",
    "content/sources/registry.json": "{}",
    "tests/blog-ci-workflow.test.mjs": payload("tests"),
  });
  for (const script of ["check-separation.mjs", "check-citations.mjs"]) {
    const r = run(script, s);
    if (script === "check-separation.mjs") {
      assert.equal(r.status, 1, r.stdout);
      for (const path of ["seo-engine/ci/check-separation.mjs", "seo-engine/approvers.json", ".github/workflows/blog-trust.yml", "seo-engine/allowed_signers", "content/sources/registry.json", "package.json"]) {
        assert.ok(r.stdout.includes(path), `se debe señalar ${path}`);
      }
    }
    assert.deepEqual(outputProblems(r.stdout), []);
  }
  assert.equal(existsSync(join(sentinel, "separation")), false, "el verificador del PR no se ejecutó");
  assert.equal(existsSync(join(sentinel, "citations")), false);
  assert.equal(existsSync(join(sentinel, "sanitize")), false);
  assert.equal(existsSync(join(sentinel, "safe-git")), false);
  assert.equal(existsSync(join(sentinel, "separation-lib")), false);
  assert.equal(existsSync(join(sentinel, "x.js")), false);
  s.repo.cleanup();
});

test("el PR cambia approvers.json para declararse el responsable: sigue siendo generador (la configuración sale de la rama base)", () => {
  const s = scenario({ "seo-engine/approvers.json": JSON.stringify({ reviewer_github: "legalprevent-seo-bot" }), "content/blog/tema.md": article() });
  const r = run("check-separation.mjs", s);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /Origen: generator/);
  s.repo.cleanup();
});

test("el generador no puede autoaprobarse ni escribir reconocimientos, aprobaciones o estado approved", () => {
  const forged = {
    "content/blog/tema.md": article({ review_status: "approved", approved_at: "2026-10-20T10:00:00Z", approval: { sha: "x" }, review_ack: { by: "martingrelu" } }),
    "content/blog/approvals/tema/20261020T100000Z-approve-aaaaaaaa.json": "{}",
  };
  const s = scenario(forged);
  const r = run("check-separation.mjs", s);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(outputProblems(r.stdout), []);
  s.repo.cleanup();
});

test("enlaces simbólicos, submódulos y ejecutables en la ruta del borrador se rechazan (modo distinto de 100644)", () => {
  const cases = {
    symlink: { "content/blog/tema.md": { symlink: "../../seo-engine/approvers.json" } },
    exec: { "content/blog/tema.md": { exec: article() } },
    gitlink: { "content/blog/tema.md": { gitlink: "1".repeat(40) } },
  };
  for (const [name, changes] of Object.entries(cases)) {
    const s = scenario(changes);
    const r = run("check-separation.mjs", s);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.deepEqual(outputProblems(r.stdout), [], name);
    const c = run("check-citations.mjs", s);
    assert.equal(c.status, 1, `${name} (citations): ${c.stdout}`);
    s.repo.cleanup();
  }
});

test("rutas con saltos de línea, '::' y caracteres bidi no inyectan comandos de workflow ni caracteres de control en el log", () => {
  const evil = [
    "content/blog/x\n::set-output name=pwn::1.md",
    "::error::falso.md",
    "dir/‮exe.md",
    "a%0A::add-mask::x.md",
    "x\r::warning::y.md",
  ];
  const changes = Object.fromEntries(evil.map((p) => [p, "x"]));
  const s = scenario(changes);
  const summaryDir = mkdtempSync(join(tmpdir(), "lp-summary-"));
  const summary = join(summaryDir, "summary.md");
  for (const script of ["check-separation.mjs", "check-citations.mjs"]) {
    const r = run(script, s, { summary });
    assert.deepEqual(outputProblems(r.stdout), [], r.stdout);
    // Solo cuenta un comando de workflow si abre la línea: la carga hostil queda dentro del mensaje de un único `::error`.
    for (const line of r.stdout.split("\n")) assert.ok(!/^::(?!error )/.test(line), line.slice(0, 60));
    assert.ok(!/(^|\n)::(set-output|add-mask|set-env|add-path|warning|notice|stop-commands)/.test(r.stdout + r.stderr));
  }
  const text = existsSync(summary) ? readFileSync(summary, "utf8") : "";
  assert.doesNotMatch(text, /[‮\r]/);
  s.repo.cleanup();
});

test("autor y rama con inyección (saltos de línea, '::', comillas, $()) no se interpretan: se tratan como datos", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const sentinel = join(sentinelDir(), "pwn");
  for (const author of [`x\n::set-env name=A::b`, `$(touch ${sentinel})`, "`touch x`", "'; touch x; '", "../../etc/passwd", "a".repeat(5000)]) {
    const r = run("check-separation.mjs", s, { author, branch: `seo/${author}` });
    assert.deepEqual(outputProblems(r.stdout), [], JSON.stringify(author).slice(0, 60));
    assert.match(r.stdout, /Origen: generator/);
  }
  assert.equal(existsSync(sentinel), false);
  s.repo.cleanup();
});

test("SHAs inválidos o con forma de opción de git se rechazan antes de llamar a git (falla cerrado)", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const out = join(sentinelDir(), "out");
  const bad = ["--output=" + out, "-h", "HEAD", "main", "", "abc", "g".repeat(40), s.head.toUpperCase().slice(0, 39), `${s.head} --stat`, "0".repeat(40)];
  for (const head of bad) {
    const r = runTrusted("check-separation.mjs", { repo: s.repo, base: s.base, head, ...GEN });
    assert.equal(r.status, 1, `HEAD_SHA=${head.slice(0, 30)}`);
  }
  for (const base of bad) {
    const r = runTrusted("check-citations.mjs", { repo: s.repo, base, head: s.head, ...GEN });
    assert.equal(r.status, 1, `BASE_SHA=${base.slice(0, 30)}`);
  }
  assert.equal(existsSync(out), false, "no se pudo inyectar una opción de git");
  s.repo.cleanup();
});

test("sin BASE_SHA/HEAD_SHA, o con PR_NUMBER inválido en modo FETCH_PR, el control falla en lugar de pasar", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  for (const script of ["check-separation.mjs", "check-citations.mjs"]) {
    assert.equal(runTrusted(script, { repo: s.repo, base: undefined, head: undefined, ...GEN }).status, 1);
    assert.equal(runTrusted(script, { repo: s.repo, base: s.base, head: s.head, ...GEN, env: { FETCH_PR: "1", PR_NUMBER: "1; id" } }).status, 1);
    assert.equal(runTrusted(script, { repo: s.repo, base: s.base, head: s.head, ...GEN, env: { FETCH_PR: "1", PR_NUMBER: "7" } }).status, 1, "sin refs/pull/7/head no se acepta");
  }
  s.repo.cleanup();
});

test("la configuración del repositorio hostil (diff.external, core.fsmonitor, hooks, pager, attributes) no ejecuta nada", () => {
  const sentinel = sentinelDir();
  const mark = (n) => `sh -c 'echo x > ${join(sentinel, n)}'`;
  const s = scenario({ "content/blog/tema.md": article({ title: "otro" }), ".gitattributes": "*.md diff=evil filter=evil\n" }, { baseChanges: { "content/blog/tema.md": article() } });
  s.repo.git("config", "diff.external", mark("external"));
  s.repo.git("config", "diff.evil.textconv", mark("textconv"));
  s.repo.git("config", "filter.evil.smudge", mark("smudge"));
  s.repo.git("config", "core.fsmonitor", mark("fsmonitor"));
  s.repo.git("config", "core.pager", mark("pager"));
  s.repo.git("config", "core.hooksPath", join(sentinel, "hooks"));
  s.repo.git("config", "core.sshCommand", mark("ssh"));
  for (const script of ["check-separation.mjs", "check-citations.mjs"]) run(script, s);
  for (const name of ["external", "textconv", "smudge", "fsmonitor", "pager", "ssh"]) assert.equal(existsSync(join(sentinel, name)), false, `${name} no debe ejecutarse`);
  s.repo.cleanup();
});

test("PR apilado (main ← A ← B): se evalúa solo lo que B añade sobre su base y una base que avanza no cambia el veredicto", () => {
  const repo = makeRepo();
  repo.commit({ "README.md": "m\n" }, "main");
  repo.branch("a");
  const a = repo.commit({ "content/blog/otro.md": article({ slug: "otro" }) }, "a");
  repo.branch("b");
  const b = repo.commit({ "content/blog/tema.md": article() }, "b");
  const r1 = runTrusted("check-separation.mjs", { repo, base: a, head: b, ...GEN });
  assert.equal(r1.status, 0, r1.stdout);
  assert.match(r1.stdout, /Ficheros cambiados: 1\./);
  // La base avanza (otro commit en A que toca el registro): el diff es contra el ancestro común, así que el veredicto
  // y los ficheros evaluados no cambian por lo que ocurra después en la base.
  repo.git("checkout", "-q", "a");
  const a2 = repo.commit({ "content/sources/registry.json": "{}" }, "a2");
  const r2 = runTrusted("check-separation.mjs", { repo, base: a2, head: b, ...GEN });
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /Ficheros cambiados: 1\./);
  // Y un PR que sí toca el registro se rechaza aunque la base ya lo tuviera tocado antes.
  repo.git("checkout", "-q", "b");
  const b2 = repo.commit({ "content/sources/registry.json": '{"x":1}' }, "b2");
  assert.equal(runTrusted("check-separation.mjs", { repo, base: a2, head: b2, ...GEN }).status, 1);
  repo.cleanup();
});

test("citations: artículo aprobado sin registro, registro inválido, JSON hostil y nombre/slug distintos fallan cerrado", () => {
  const approved = article({ review_status: "approved", approved_at: "2026-10-20T10:00:00Z", citations: [] });
  const cases = {
    "aprobado sin registro": { "content/blog/tema.md": approved },
    "registro no es JSON": { "content/blog/tema.md": approved, "content/sources/registry.json": "{no json" },
    "registro vacío": { "content/blog/tema.md": approved, "content/sources/registry.json": "{}" },
    "prototype pollution": { "content/blog/tema.md": approved, "content/sources/registry.json": '{"__proto__":{"x":1},"sources":[]}' },
    "slug distinto del fichero": { "content/blog/otro.md": article({ slug: "tema" }) },
    "front matter ilegible": { "content/blog/tema.md": "---\n{no\n---\nx" },
    "artículo gigante": { "content/blog/tema.md": article({}, "x".repeat(2_000_000)) },
    "binario": { "content/blog/tema.md": Buffer.from([0, 255, 254, 0, 1, 2]) },
  };
  for (const [name, changes] of Object.entries(cases)) {
    const s = scenario(changes);
    const r = run("check-citations.mjs", s, { author: "martingrelu", branch: "feat/x" });
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.deepEqual(outputProblems(r.stdout), [], name);
    s.repo.cleanup();
  }
});

test("citations: un PR sin artículos aprobados no verifica nada y pasa; un artículo en draft no necesita registro", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const r = run("check-citations.mjs", s);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Sin artículos aprobados/);
  s.repo.cleanup();
});

test("citations: el control no usa la red (fetch bloqueado) y no escribe fuera del directorio temporal", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const marker = join(sentinelDir(), "net");
  const preload = join(sentinelDir(), "block-fetch.mjs");
  // El preload sustituye a fetch por una función que deja una marca: si el control tocara la red, la marca aparecería.
  const code = `import { writeFileSync } from "node:fs"; globalThis.fetch = () => { writeFileSync(${JSON.stringify(marker)}, "red"); throw new Error("red bloqueada"); };`;
  writeFileSyncSafe(preload, code);
  const r = run("check-citations.mjs", s, { env: { NODE_OPTIONS: `--import=${preload}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(marker), false, "check-citations no usó fetch");
  s.repo.cleanup();
});

import { writeFileSync } from "node:fs";
function writeFileSyncSafe(path, text) {
  writeFileSync(path, text);
}

test("el repositorio de confianza no se modifica al ejecutar los controles (sin escrituras en el árbol base)", () => {
  const s = scenario({ "content/blog/tema.md": article() });
  const before = s.repo.git("status", "--porcelain");
  run("check-separation.mjs", s);
  run("check-citations.mjs", s);
  assert.equal(s.repo.git("status", "--porcelain"), before, "el repositorio verificado queda intacto");
  assert.equal(s.repo.git("rev-parse", "HEAD"), s.head);
  s.repo.cleanup();
});
