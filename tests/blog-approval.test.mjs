// Verificación de aprobaciones jurídicas (seo-engine/verify-approval.mjs): una aprobación
// inválida, revocada, ajena o de un contenido modificado NO supera la verificación.
// Usa un cliente de GitHub falso; no hay red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../seo-engine/blog-render.mjs";
import { githubClient, latestDecisiveReview, verifyArticle } from "../seo-engine/verify-approval.mjs";

const REVIEWER = "martingrelu";
const PR = 28;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BODY = "Texto de prueba.";
const META = {
  slug: "tema-real",
  title: "Tema real",
  description: "Descripción.",
  date_published: "2026-10-01",
  date_modified: "2026-10-15",
};
const source = (meta, body) => `---\n${JSON.stringify(meta)}\n---\n${body}`;
const hash = contentHash(META, BODY);
const article = (approval = { pr: PR, content_sha256: hash }) => ({
  meta: { ...META, review_status: "approved", approved_at: "2026-10-15", approval },
  body: BODY,
});
const review = (state, commit_id = SHA_A, login = REVIEWER) => ({ state, commit_id, user: { login } });

// `files` mapea commit → texto del artículo en ese commit.
function client({ reviews = [], files = { [SHA_A]: source({ ...META, review_status: "approved" }, BODY) }, fail } = {}) {
  return {
    async getReviews(pr) {
      if (fail) throw new Error(fail);
      return reviews[pr] ?? reviews;
    },
    async getFile(path, ref) {
      if (fail) throw new Error(fail);
      assert.equal(path, "content/blog/tema-real.md");
      if (!(ref in files)) throw new Error(`GitHub API 404 al leer ${path}@${ref.slice(0, 7)}`);
      return files[ref];
    },
  };
}
const verify = (art, options) =>
  verifyArticle(art, { reviewerLogin: REVIEWER, currentPr: PR, headSha: SHA_A, client: client(), ...options });

test("aprobación válida: APPROVED del responsable sobre la cabeza de la PR y contenido idéntico", async () => {
  const result = await verify(article(), { client: client({ reviews: [review("COMMENTED"), review("APPROVED")] }) });
  assert.equal(result.ok, true, result.reason);
  assert.match(result.reason, /PR #28/);
});

test("el usuario del responsable se compara sin distinguir mayúsculas", async () => {
  assert.equal((await verify(article(), { client: client({ reviews: [review("APPROVED", SHA_A, "MartinGrelu")] }) })).ok, true);
});

test("sin revisión, de otra persona o solo comentarios: falla", async () => {
  for (const reviews of [[], [review("APPROVED", SHA_A, "otra-persona")], [review("COMMENTED")], [review("PENDING")]]) {
    const result = await verify(article(), { client: client({ reviews }) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no ha revisado/);
  }
});

test("aprobación revocada (cambios solicitados o descartada después): falla", async () => {
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
    const result = await verify(article(), { client: client({ reviews: [review("APPROVED"), review(state)] }) });
    assert.equal(result.ok, false, state);
    assert.match(result.reason, new RegExp(state));
  }
  // Una aprobación posterior a la revocación vuelve a valer.
  assert.equal((await verify(article(), { client: client({ reviews: [review("CHANGES_REQUESTED"), review("APPROVED")] }) })).ok, true);
});

test("aprobación de un contenido distinto al actual: falla", async () => {
  // El artículo actual declara un hash, pero lo aprobado en ese commit era otro texto.
  const viejo = { [SHA_A]: source({ ...META, review_status: "approved" }, "Texto anterior, ya aprobado.") };
  const result = await verify(article(), { client: client({ reviews: [review("APPROVED")], files: viejo }) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no coincide con approval\.content_sha256/);
  // Y el caso inverso: el hash declarado no es el del contenido real.
  const falso = article({ pr: PR, content_sha256: "0".repeat(64) });
  assert.equal((await verify(falso, { client: client({ reviews: [review("APPROVED")] }) })).ok, false);
});

test("en la misma PR, un push posterior a la aprobación exige una aprobación nueva", async () => {
  const reviews = [review("APPROVED", SHA_A)];
  const files = { [SHA_A]: source({ ...META, review_status: "approved" }, BODY) };
  const stale = await verify(article(), { headSha: SHA_B, client: client({ reviews, files }) });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /cabeza de la PR cambió/);
  assert.equal((await verify(article(), { headSha: undefined, client: client({ reviews, files }) })).ok, false);
});

test("un artículo ya fusionado (otra PR) no depende de la cabeza de la PR actual", async () => {
  const merged = article({ pr: 12, content_sha256: hash });
  const result = await verify(merged, { currentPr: PR, headSha: SHA_B, client: client({ reviews: { 12: [review("APPROVED", SHA_A)] } }) });
  assert.equal(result.ok, true, result.reason);
  // Y tras fusionar (evento push a main) tampoco hay cabeza que comparar.
  assert.equal((await verify(merged, { currentPr: undefined, headSha: undefined, client: client({ reviews: { 12: [review("APPROVED", SHA_A)] } }) })).ok, true);
});

test("la verificación falla cerrada ante errores de la API o datos inválidos", async () => {
  assert.match((await verify(article(), { client: client({ fail: "GitHub API 500" }) })).reason, /no se pudo verificar: GitHub API 500/);
  assert.equal((await verify(article(), { client: client({ reviews: [review("APPROVED", "no-es-un-sha")] }) })).ok, false);
  assert.match((await verify(article(), { client: client({ reviews: [review("APPROVED", SHA_B)] }) })).reason, /no se pudo verificar/);
  const sinFormato = client({ reviews: [review("APPROVED")], files: { [SHA_A]: "sin front matter" } });
  assert.equal((await verify(article(), { client: sinFormato })).ok, false);
});

test("un artículo sin aprobar o un fixture en content/blog no pasan", async () => {
  const borrador = { meta: { ...META, review_status: "in_review" }, body: BODY };
  assert.match((await verify(borrador)).reason, /no está aprobado/);
  const fixture = article();
  fixture.meta.fixture = true;
  assert.match((await verify(fixture, { client: client({ reviews: [review("APPROVED")] }) })).reason, /fixture/);
});

test("latestDecisiveReview ignora comentarios y respeta el orden", () => {
  assert.equal(latestDecisiveReview([review("APPROVED"), review("COMMENTED")], REVIEWER).state, "APPROVED");
  assert.equal(latestDecisiveReview([review("APPROVED"), review("DISMISSED")], REVIEWER).state, "DISMISSED");
  assert.equal(latestDecisiveReview([review("COMMENTED")], REVIEWER), undefined);
});

test("githubClient usa solo GET de lectura, pagina y falla ante respuestas no válidas", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/reviews?") && url.endsWith("page=1")) return { ok: true, json: async () => Array.from({ length: 100 }, () => review("COMMENTED")) };
    if (url.includes("/reviews?")) return { ok: true, json: async () => [review("APPROVED")] };
    if (url.includes("/contents/")) return { ok: true, text: async () => "contenido" };
    return { ok: false, status: 403 };
  };
  const api = githubClient("o/r", "token-falso", fakeFetch);
  assert.equal((await api.getReviews(28)).length, 101);
  assert.equal(await api.getFile("content/blog/x.md", SHA_A), "contenido");
  for (const { init } of calls) {
    assert.equal(init.method, undefined, "solo GET (sin método explícito)");
    assert.equal(init.body, undefined);
  }
  await assert.rejects(githubClient("o/r", "t", async () => ({ ok: false, status: 403 })).getReviews(1), /403/);
  await assert.rejects(githubClient("o/r", "t", async () => ({ ok: true, json: async () => ({}) })).getReviews(1), /inesperada/);
});
