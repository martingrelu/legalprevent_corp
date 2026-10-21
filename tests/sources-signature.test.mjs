// Las citas, los candados y los reconocimientos de revisión están protegidos por la firma del responsable:
// cualquier cambio posterior invalida la aprobación (el hash del contenido los incluye). El registro de fuentes NO
// está en ese hash; lo protege `source_sha256`, el hash de la entrada que cada candado lleva dentro del artículo.
// Claves SSH efímeras en un directorio temporal; sin red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecord, evaluateApproval, NAMESPACE, recordFileName, signStatement, statementFor } from "../seo-engine/approval-signature.mjs";
import { contentHash } from "../seo-engine/blog-render.mjs";
import { evaluateBoe, parseBlock, parseIndex, parseMetadata } from "../seo-engine/sources/adapters/boe.mjs";
import { createWebClient, verifyWebCitation } from "../seo-engine/sources/adapters/web.mjs";
import { verifyArticleCitations } from "../seo-engine/sources/verify-citations.mjs";

const work = mkdtempSync(join(tmpdir(), "lp-sources-sig-"));
after(() => rmSync(work, { recursive: true, force: true }));
const priv = join(work, "key");
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", priv]);
const pub = readFileSync(`${priv}.pub`, "utf8").trim();
const fingerprint = execFileSync("ssh-keygen", ["-l", "-f", `${priv}.pub`], { encoding: "utf8" }).match(/(SHA256:\S+)/)[1];
const ID = "martingrelu";
const NOW = new Date("2026-10-21T12:00:00Z");
const approvalOptions = { allowedSigners: `${ID} namespaces="${NAMESPACE}" ${pub}\n`, identity: ID, pinnedFingerprint: fingerprint, now: NOW };

const read = (path) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8"));
const lopdgdd = registry.sources.find((entry) => entry.id === "boe-lo-3-2018");
const insst = registry.sources.find((entry) => entry.id === "insst-gt-simplificacion-documental");
const QUOTE = "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679";

const boeLock = evaluateBoe({
  entry: lopdgdd,
  citation: { locator: { article: "5" }, quote: QUOTE },
  meta: parseMetadata(read("boe/metadatos-BOE-A-2018-16673.json")),
  index: parseIndex(read("boe/indice-BOE-A-2018-16673.json")),
  block: parseBlock(read("boe/bloque-BOE-A-2018-16673-a5.xml")),
  now: NOW,
}).lock;
const reply = (type, body) => ({ status: 200, headers: new Headers({ "content-type": type }), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
const routes = {
  "https://www.insst.es/robots.txt": reply("text/plain", read("web/robots-insst.txt")),
  [insst.urls.canonical]: reply("text/html; charset=UTF-8", read("web/insst-ficha-simplificacion.html")),
  [insst.urls.document]: reply("application/pdf", "%PDF-1.4 sintético"),
};
const webLock = (await verifyWebCitation({ client: createWebClient({ fetchImpl: async (url) => routes[url], delayMs: 0, sleep: async () => {} }), entry: insst, citation: { locator: { section: "Resumen" } }, now: NOW })).lock;

const base = () => ({
  meta: {
    slug: "tema-real",
    title: "Tema real",
    description: "Descripción.",
    date_published: "2026-10-01",
    date_modified: "2026-10-15",
    review_status: "approved",
    approved_at: "2026-10-21",
    citations: [
      { id: "c1", source: lopdgdd.id, type: "norma", locator: { article: "5" }, quote: QUOTE, lock: structuredClone(boeLock) },
      { id: "g1", source: insst.id, type: "criterio", locator: { section: "Resumen" }, lock: structuredClone(webLock) },
    ],
    review_ack: [
      { citation: "g1", reason: "vigencia_no_acreditable", note: "Guía técnica del INSST: se acepta como criterio, sin afirmar su vigencia." },
      { citation: "g1", reason: "solo_existencia", note: "Solo se cita la existencia de la guía y su carácter no vinculante." },
    ],
  },
  body: "Texto del artículo sin referencias normativas.",
});

function sign({ meta, body }, timestamp = "2026-10-21T10:00:00Z") {
  const fields = { action: "approve", slug: meta.slug, sha256: contentHash(meta, body), timestamp };
  const record = buildRecord({ ...fields, identity: ID, signature: signStatement(statementFor(fields), priv) });
  return [{ file: recordFileName(record), record }];
}
const signed = sign(base());
const approved = (art) => evaluateApproval(art, signed, approvalOptions);

test("el artículo con citas, candados y reconocimientos, tal como se firmó, está aprobado y sus citas no bloquean", () => {
  const art = base();
  assert.equal(approved(art).ok, true, approved(art).reason);
  const citations = verifyArticleCitations(art, registry, { now: NOW });
  assert.equal(citations.blocking, false, JSON.stringify(citations.items));
  assert.deepEqual(citations.items.map((item) => [item.citation, item.status, item.pending]), [["c1", "verified", []], ["g1", "needs_review", []]]);
});

test("cambiar un reconocimiento de revisión (nota, motivo, cita) o quitarlo invalida la firma", () => {
  const edits = {
    "editar la nota": (a) => (a.meta.review_ack[0].note = "Nota distinta escrita después de la firma."),
    "cambiar el motivo": (a) => (a.meta.review_ack[0].reason = "pdf_sin_verificacion_textual"),
    "cambiar la cita reconocida": (a) => (a.meta.review_ack[0].citation = "c1"),
    "quitar un reconocimiento": (a) => a.meta.review_ack.pop(),
    "quitar todos": (a) => delete a.meta.review_ack,
    "añadir uno": (a) => a.meta.review_ack.push({ citation: "(cuerpo)", reason: "referencia_sin_cita", note: "Reconocimiento añadido después de la firma." }),
  };
  for (const [label, edit] of Object.entries(edits)) {
    const art = base();
    edit(art);
    const result = approved(art);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, /no hay ninguna aprobación firmada/, label);
  }
});

test("cambiar un candado, una cita, una fuente o el localizador invalida la firma", () => {
  const edits = {
    "hash del texto del candado BOE": (a) => (a.meta.citations[0].lock.text_sha256 = "f".repeat(64)),
    "fecha de comprobación": (a) => (a.meta.citations[0].lock.verified_at = "2026-10-20"),
    "estado del candado": (a) => ((a.meta.citations[1].lock.status = "verified"), (a.meta.citations[1].lock.reasons = [])),
    "hash del documento PDF": (a) => (a.meta.citations[1].lock.document.content_sha256 = "f".repeat(64)),
    "quitar un candado": (a) => delete a.meta.citations[0].lock,
    "editar la cita": (a) => (a.meta.citations[0].quote = `${QUOTE} y además algo más`),
    "cambiar el tipo (guía como norma)": (a) => (a.meta.citations[1].type = "norma"),
    "cambiar la fuente": (a) => (a.meta.citations[0].source = "boe-l-31-1995"),
    "cambiar el localizador": (a) => (a.meta.citations[0].locator = { article: "6" }),
    "añadir una cita": (a) => a.meta.citations.push({ id: "c2", source: lopdgdd.id, type: "norma", locator: { article: "5" } }),
    "quitar una cita": (a) => a.meta.citations.pop(),
    "el texto del artículo": (a) => (a.body += " Añadido."),
  };
  for (const [label, edit] of Object.entries(edits)) {
    const art = base();
    edit(art);
    assert.equal(approved(art).ok, false, label);
  }
});

test("los campos de aprobación (approved_at) no cuentan: son los que cambian al aprobar", () => {
  const art = base();
  art.meta.approved_at = "2026-10-21";
  assert.equal(approved(art).ok, true);
});

test("el registro no está en el hash del artículo, pero un candado lleva el hash de su entrada: reclasificar tras firmar bloquea", () => {
  // La firma sigue siendo válida porque el artículo no cambió...
  const tampered = { version: 1, sources: registry.sources.map((entry) => (entry.id === insst.id ? { ...entry, kind: "texto_consolidado", binding: "informativo" } : entry)) };
  assert.equal(approved(base()).ok, true);
  // ...pero la verificación de citas detecta que la entrada del registro ya no es la que se comprobó y se firmó.
  const result = verifyArticleCitations(base(), tampered, { now: NOW });
  assert.equal(result.blocking, true);
  assert.deepEqual(result.items.find((item) => item.citation === "g1").failed, ["registro_modificado"]);
});

test("las dos puertas son necesarias: una firma válida no basta con citas que bloquean, y viceversa", () => {
  const art = base();
  art.meta.review_ack = [art.meta.review_ack[0]]; // falta reconocer solo_existencia
  const result = verifyArticleCitations(art, registry, { now: NOW });
  assert.equal(result.blocking, true, "el reconocimiento que falta bloquea");
  assert.equal(evaluateApproval(art, sign(art), approvalOptions).ok, true, "aunque el responsable firme esa versión, la puerta de las citas sigue cerrada");
  assert.equal(approved(art).ok, false, "y la firma de otra versión no sirve para esta");
});
