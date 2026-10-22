// Comprobación EN LÍNEA de las citas del BOE (única parte que usa la red). Solo lectura de la API oficial.
//
//   node seo-engine/sources/verify-sources.mjs --lock <slug> [--write]   comprueba y calcula los candados
//   node seo-engine/sources/verify-sources.mjs --check [<slug>]          recalcula y compara con los candados guardados
//
// --lock escribe los candados en el artículo SOLO con --write y solo si ninguna cita falla.
// --check autentica los candados: uno inventado o manipulado no coincide con la fuente en vivo.
// Un error de red o un 5xx es "inconcluso": cuenta como NO verificado (exit 1), nunca como válido.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArticles, parseRaw } from "../blog-render.mjs";
import { compareWithLock, createBoeClient, verifyBoeCitation } from "./adapters/boe.mjs";
import { compareWebWithLock, createWebClient, verifyWebCitation } from "./adapters/web.mjs";
import { loadRegistry } from "./verify-citations.mjs";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const mode = args.includes("--lock") ? "lock" : args.includes("--check") ? "check" : null;
  try {
    if (!mode) throw new Error("uso: verify-sources.mjs --lock <slug> [--write] | --check [<slug>]");
    const slug = args.find((arg, i) => !arg.startsWith("--") && (i === 0 || args[i - 1] === "--lock" || args[i - 1] === "--check"));
    if (mode === "lock" && !slug) throw new Error("--lock necesita el slug del artículo");
    const registry = loadRegistry(resolve(root, "content/sources/registry.json"));
    const bySource = new Map(registry.sources.map((entry) => [entry.id, entry]));
    const boe = createBoeClient();
    const web = createWebClient();
    const articles = loadArticles(resolve(root, "content/blog")).filter(({ meta }) => (slug ? meta.slug === slug : mode === "lock" ? false : meta.review_status === "approved"));
    if (slug && !articles.length) throw new Error(`no existe el artículo ${slug}`);
    let bad = 0;
    for (const { meta } of articles) {
      const badBefore = bad;
      const locks = new Map();
      for (const citation of meta.citations ?? []) {
        const entry = bySource.get(citation.source);
        if (!entry) {
          console.log(`  ${meta.slug}/${citation.id}: FAILED — fuente_desconocida`);
          bad++;
          continue;
        }
        const isBoe = entry.authority === "BOE";
        let result = isBoe ? await verifyBoeCitation({ client: boe, entry, citation }) : await verifyWebCitation({ client: web, entry, citation });
        if (mode === "check") {
          if (!citation.lock) result = { status: "failed", reasons: ["sin_candado"] };
          else if (!result.inconclusive) result = isBoe ? compareWithLock(result, citation.lock) : compareWebWithLock(result, citation.lock);
        }
        console.log(`  ${meta.slug}/${citation.id}: ${result.status.toUpperCase()}${result.reasons.length ? ` — ${result.reasons.join(", ")}` : ""}${result.detail ? ` (${result.detail})` : ""}`);
        if (result.status === "failed" || result.inconclusive) bad++;
        else if (result.lock) locks.set(citation.id, result.lock);
      }
      if (mode === "lock") {
        if (bad > badBefore) console.log("  Hay citas que fallan o no se pueden verificar: no se escribe ningún candado.");
        else if (args.includes("--write")) {
          const file = resolve(root, "content/blog", `${meta.slug}.md`);
          const raw = parseRaw(readFileSync(file, "utf8"), file);
          raw.meta.citations = raw.meta.citations.map((citation) => ({ ...citation, lock: locks.get(citation.id) }));
          writeFileSync(file, `---\n${JSON.stringify(raw.meta, null, 2)}\n---\n${raw.body}\n`);
          console.log(`  Candados escritos en ${meta.slug}.md. Revísalos y vuelve a firmar el artículo.`);
        } else console.log("  Comprobación correcta. Usa --write para escribir los candados.");
      }
    }
    if (!articles.length) console.log("Sin artículos aprobados: nada que comprobar.");
    process.exit(bad ? 1 : 0);
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  }
}
