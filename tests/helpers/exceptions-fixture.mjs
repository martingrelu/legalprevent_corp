// Escenario común de las pruebas de excepciones firmadas: una cita real del INSST con candado, claves efímeras y registros.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebClient, verifyWebCitation } from "../../seo-engine/sources/adapters/web.mjs";
import { EXCEPTION_NAMESPACE, bindingFor, recordFileName, signStatement, statementFor } from "../../seo-engine/sources/exceptions.mjs";
import { verifyArticleCitations } from "../../seo-engine/sources/verify-citations.mjs";

const webFx = (n) => readFileSync(new URL(`../fixtures/web/${n}`, import.meta.url), "utf8");
export const registry = JSON.parse(readFileSync(new URL("../../content/sources/registry.json", import.meta.url), "utf8"));
export const insst = registry.sources.find((s) => s.id === "insst-gt-simplificacion-documental");
export const aepd = registry.sources.find((s) => s.id === "aepd-guia-calidad-datos-ia");
export const lopd = registry.sources.find((s) => s.id === "boe-lo-3-2018");
export const IDENTITY = "martingrelu";
export const DAY = 86_400_000;

const reply = (type, body) => ({ status: 200, headers: new Headers({ "content-type": type }), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
const routes = {
  "https://www.insst.es/robots.txt": reply("text/plain", webFx("robots-insst.txt")),
  "https://www.aepd.es/robots.txt": reply("text/plain", webFx("robots-aepd.txt")),
  [insst.urls.canonical]: reply("text/html; charset=UTF-8", webFx("insst-ficha-simplificacion.html")),
  [insst.urls.document]: reply("application/pdf", "%PDF-1.4 sintético"),
  [aepd.urls.canonical]: reply("application/pdf", "%PDF-1.4 sintético"),
  [aepd.urls.index]: reply("text/html; charset=UTF-8", webFx("aepd-listado-guias.html")),
};
// Igual que fixtureClient, pero el INSST ahora sirve una ficha con el contenido cambiado (la fuente responde, pero distinta).
export const changedClient = () => createWebClient({
  fetchImpl: async (url) => (url === insst.urls.canonical ? reply("text/html; charset=UTF-8", webFx("insst-ficha-simplificacion.html").replace(/<h1([^>]*)>([^<]+)/, "<h1$1>$2 (texto actualizado por la fuente)")) : routes[url] ?? { status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }),
  delayMs: 0,
  sleep: async () => {},
});
export const fixtureClient = () => createWebClient({ fetchImpl: async (url) => routes[url] ?? { status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }, delayMs: 0, sleep: async () => {} });

// Candado real del INSST calculado a `now` (para que la antigüedad sea la que cada prueba necesite).
export async function webLockAt(entry, now) {
  return structuredClone((await verifyWebCitation({ client: fixtureClient(), entry, citation: { locator: { section: "Resumen" } }, now })).lock);
}
export const webCitation = (entry, lock, patch = {}) => ({ id: "g1", source: entry.id, type: "criterio", locator: { section: "Resumen" }, lock: structuredClone(lock), ...patch });
export const articleWith = (citations, meta = {}, body = "Texto del artículo.") => ({
  meta: { slug: "tema", title: "Tema", description: "Descripción.", date_published: "2026-10-01", date_modified: "2026-10-15", review_status: "approved", approved_at: "2026-10-21", citations, review_ack: [{ citation: "g1", reason: "vigencia_no_acreditable", note: "Revisada por el responsable." }], ...meta },
  body,
});

// Claves SSH efímeras.
export function genKey(name = "k") {
  const dir = mkdtempSync(join(tmpdir(), "lp-exkey-"));
  const priv = join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", priv]);
  const pub = readFileSync(`${priv}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-l", "-f", `${priv}.pub`], { encoding: "utf8" }).match(/(SHA256:\S+)/)[1];
  // Igual que en producción: la clave del responsable está restringida al espacio de nombres de las aprobaciones.
  const allowedSigners = `${IDENTITY} namespaces="legalprevent-blog-approval" ${pub.split(" ").slice(0, 2).join(" ")}\n`;
  return { priv, pub, fingerprint, allowedSigners };
}

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// Registro firmado a mano (para construir casos válidos y adversos).
export function signedRecord({ action = "grant", binding, issued_at, expires_at, key, identity = IDENTITY, namespaceOverride, mutate }) {
  const record = { version: 1, action, binding, issued_at, ...(action === "grant" ? { expires_at } : {}), reason: "fuente_inalcanzable", identity };
  const statement = statementFor({ action, binding, issued_at, expires_at });
  if (namespaceOverride) {
    const dir = mkdtempSync(join(tmpdir(), "lp-exsig-"));
    writeFileSync(join(dir, "s.txt"), statement);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", key.priv, "-n", namespaceOverride, join(dir, "s.txt")], { stdio: "pipe" });
    record.signature = readFileSync(join(dir, "s.txt.sig"), "utf8");
  } else record.signature = signStatement(statement, key.priv);
  const final = mutate ? mutate(record) : record;
  return { file: recordFileName(final), record: final };
}

// Todo lo necesario para evaluar una excepción sobre la cita del INSST.
export async function scenario({ now, lockAgeDays = 1, entry = insst, citationPatch = {} } = {}) {
  const lockNow = new Date(now.getTime() - lockAgeDays * DAY);
  const lock = await webLockAt(entry, lockNow);
  const citation = webCitation(entry, lock, citationPatch);
  const art = articleWith([citation]);
  const offline = verifyArticleCitations(art, registry, { now });
  const offlineItem = offline.items.find((i) => i.citation === "g1");
  const binding = bindingFor({ meta: art.meta, body: art.body, citation, entry });
  const key = genKey("approver");
  return { now, lock, citation, art, entry, offlineItem, binding, key, base: { meta: art.meta, body: art.body, citation, entry, offlineItem, allowedSigners: key.allowedSigners, identity: IDENTITY, pinnedFingerprint: key.fingerprint, now } };
}
export { EXCEPTION_NAMESPACE, mkdirSync };
