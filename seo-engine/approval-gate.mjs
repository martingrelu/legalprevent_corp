// Puerta de verificación PREVIA a firmar una aprobación (F2.4). `approve.mjs` no firma si las citas del artículo no superan
// este control: primero offline (candado, registro, tipos, reconocimientos) y después EN VIVO en modo estricto con reintentos.
//
// Es un cinturón de seguridad para el responsable, no el control de fondo: los controles que no se pueden saltar son los de CI
// (`citations`, `sources-live`, desde la rama base) y la propia firma. La puerta evita firmar algo que el CI va a rechazar.
// La aprobación y las excepciones siguen siendo firmas independientes: aquí no se firma nada ni se escribe nada.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allowedSignersFingerprint } from "./approval-signature.mjs";
import { createBoeClient } from "./sources/adapters/boe.mjs";
import { createWebClient } from "./sources/adapters/web.mjs";
import { loadRecords } from "./sources/exceptions.mjs";
import { formatLiveItem, liveCheckArticle } from "./sources/live-check.mjs";
import { formatItem, loadRegistry, verifyArticleCitations } from "./sources/verify-citations.mjs";

// Devuelve { ok, stage, problems, exceptional, offline, live }. Nunca lanza por un fallo de la fuente: un fallo es `ok: false`.
export async function approvalGate({ root, meta, body, identity, now = new Date(), boe, web, retry, clients = { boe: createBoeClient, web: createWebClient } }) {
  const fail = (stage, problems, extra = {}) => ({ ok: false, stage, problems, exceptional: [], ...extra });
  const registryPath = resolve(root, "content/sources/registry.json");
  if (!existsSync(registryPath)) return fail("registro", ["falta content/sources/registry.json: no se puede verificar ninguna cita"]);
  let registry;
  try {
    registry = loadRegistry(registryPath);
  } catch (error) {
    return fail("registro", [`registro de fuentes inválido: ${String(error.message).split("\n")[0]}`]);
  }

  // 1) Offline: nada de red hasta que el artículo sea coherente.
  const offline = verifyArticleCitations({ meta, body }, registry, { now });
  if (offline.blocking) {
    return fail("offline", offline.items.filter((i) => i.blocking).map((i) => `OFFLINE ${formatItem(i)}`), { offline });
  }

  // 2) En vivo, estricto, con reintentos. Las excepciones firmadas vigentes (F2.3c) pueden cubrir AEPD/INSST inaccesibles.
  let exceptions;
  const signersPath = resolve(root, "seo-engine/allowed_signers");
  if (existsSync(signersPath) && identity) {
    const allowedSigners = readFileSync(signersPath, "utf8");
    const found = allowedSignersFingerprint(allowedSigners, identity);
    if (found.ok) exceptions = { recordsFor: (slug) => loadRecords(resolve(root, "content/blog/exceptions"), slug), allowedSigners, identity, pinnedFingerprint: found.fingerprint };
  }
  let live;
  try {
    live = await liveCheckArticle({ meta, body }, registry, { boe: boe ?? clients.boe(), web: web ?? clients.web(), now, retry, mode: "strict", exceptions });
  } catch (error) {
    return fail("en_vivo", [`la comprobación en vivo falló: ${String(error?.message ?? error)}`], { offline }); // un error técnico NUNCA permite firmar
  }
  const exceptional = live.items.filter((i) => i.outcome === "exceptional_review");
  if (live.blocking) {
    const problems = live.items.filter((i) => i.blocking).map((i) => {
      const hint = i.outcome === "unreachable" && i.exceptionable ? ` → si la fuente sigue sin responder, el responsable puede firmar una excepción: node seo-engine/except.mjs ${meta.slug} ${i.citation}` : "";
      return `EN VIVO ${formatLiveItem(i)}${hint}`;
    });
    return fail("en_vivo", problems, { offline, live, exceptional });
  }
  return { ok: true, stage: "ok", problems: [], exceptional, offline, live };
}
