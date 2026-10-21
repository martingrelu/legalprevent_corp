// Sonda NO bloqueante de accesibilidad de las fuentes web (D5). Siempre termina con código 0.
// Lee las URL de content/sources/registry.json de la rama (confianza) y solo las de autoridades AEPD/INSST.
import { readFileSync, appendFileSync } from "node:fs";

const UA = "LegalPreventSourceProbe/1.0 (+https://legalprevent.com; solo lectura)";
const MAX_BYTES = 512 * 1024;
const HOSTS = new Set(["www.aepd.es", "www.insst.es"]);
const summary = process.env.GITHUB_STEP_SUMMARY;
const out = (line) => { console.log(line); if (summary) appendFileSync(summary, `${line}\n`); };

const registry = JSON.parse(readFileSync("content/sources/registry.json", "utf8"));
const urls = [...new Set(JSON.stringify(registry).match(/https:\/\/[^"\s]+/g) ?? [])].filter((u) => { try { return HOSTS.has(new URL(u).hostname); } catch { return false; } });

async function get(url, hops = 0) {
  if (hops > 3) return { status: "demasiadas redirecciones" };
  const started = Date.now();
  const res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const next = new URL(res.headers.get("location"), url);
    if (next.protocol !== "https:" || !HOSTS.has(next.hostname)) return { status: res.status, note: `redirige fuera de la lista (${next.hostname})` };
    return get(next.href, hops + 1);
  }
  const reader = res.body?.getReader(); let bytes = 0;
  while (reader) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > MAX_BYTES) { await reader.cancel(); break; } }
  return { status: res.status, ms: Date.now() - started, bytes };
}

out("### Sonda de accesibilidad (no bloqueante)\n\n| URL | Resultado |\n|---|---|");
for (const url of urls) {
  let result;
  try {
    const robots = await fetch(new URL("/robots.txt", url), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) }).then((r) => r.status).catch((e) => `error ${e.name}`);
    result = { robots, ...(await get(url)) };
  } catch (error) {
    result = { error: error?.name ?? "error" };
  }
  out(`| \`${new URL(url).hostname}${new URL(url).pathname.slice(0, 60)}\` | ${JSON.stringify(result).replace(/\|/g, "/")} |`);
  await new Promise((r) => setTimeout(r, 2000));
}
out(`\nURLs medidas: ${urls.length}. Esta sonda nunca falla el job.`);
process.exit(0);
