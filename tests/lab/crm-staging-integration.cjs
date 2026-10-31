// Integración LP-CRM-002 contra el proyecto de STAGING. Nunca producción.
//   STAGING_ANON_KEY=... STAGING_EMAIL=... STAGING_PASSWORD=... node tests/lab/crm-staging-integration.cjs
// Procedimiento completo: docs/crm-staging-integracion.md. Las credenciales solo viven en el entorno.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const PRODUCTION_REF = "wtpfrlsbfishvworjdtr";
const STAGING_URL = "https://ubyopnnfmajmrqhkapjk.supabase.co";
const PORT = Number(process.env.CRM_PORT || 8766);
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(ROOT, "crm-staging-results");

function assertStagingTarget(env = process.env) {
  const url = env.STAGING_URL || STAGING_URL;
  if (url !== STAGING_URL) throw new Error(`Guardia: STAGING_URL debe ser exactamente ${STAGING_URL}.`);
  if (url.includes(PRODUCTION_REF)) throw new Error("Guardia: la URL apunta a producción. Ejecución cancelada.");
  if (!env.STAGING_ANON_KEY) throw new Error("Guardia: falta STAGING_ANON_KEY.");
  if (!env.STAGING_EMAIL || !env.STAGING_PASSWORD) throw new Error("Guardia: faltan STAGING_EMAIL o STAGING_PASSWORD.");
  return { url, anonKey: env.STAGING_ANON_KEY };
}

// Servidor estático mínimo sobre la raíz del repositorio (no depende de herramientas externas).
function startStaticServer() {
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// Copia de prueba: solo registros reales ficticios (.test). Ningún dato de producción.
const FIXTURE = {
  app: "LegalPrevent CRM",
  data: {
    clients: [{ id: "cli-prueba-1", businessName: "Cliente Prueba SL", taxId: "B00000000", primaryContact: "Contacto Prueba", email: "cliente@prueba.test", plan: "Pyme" }],
    tasks: [{ id: "tar-prueba-1", title: "Llamada de prueba", relatedType: "client", relatedId: "cli-prueba-1" }],
    interactions: [{ id: "int-prueba-1", relatedType: "client", relatedId: "cli-prueba-1", kind: "Nota manual", summary: "Prueba de integración" }],
    proposals: [{ id: "pro-prueba-1", relatedClientId: "cli-prueba-1", plan: "Pyme", price: 99 }],
  },
};
const EXPECTED_IMPORT = 4;
const FIXTURE_KEYS = ["client:cli-prueba-1", "task:tar-prueba-1", "interaction:int-prueba-1", "proposal:pro-prueba-1"];

async function main() {
  const target = assertStagingTarget();
  const { chromium } = require("playwright");
  const server = await startStaticServer();
  const crmBase = `http://127.0.0.1:${PORT}/crm/index.html`;
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Protección: la configuración de producción se sustituye y cualquier otro Supabase se bloquea.
  const configJs = `window.LEGAL_PREVENT_SUPABASE = ${JSON.stringify({ url: target.url, anonKey: target.anonKey })};`;
  await context.route("**/supabase-config.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: configJs }));
  await context.route("**/*.supabase.co/**", (route) =>
    route.request().url().startsWith(target.url + "/") ? route.continue() : route.abort(),
  );

  const page = await context.newPage();
  const pageErrors = [];
  const dialogs = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const remoteRows = () =>
    page.evaluate(async (url) => {
      const session = window.LegalPreventSupabase.getSession();
      const res = await fetch(`${url}/rest/v1/crm_records?select=kind,local_id`, {
        headers: { apikey: window.LEGAL_PREVENT_SUPABASE.anonKey, Authorization: `Bearer ${session.access_token}` },
      });
      return res.ok ? { status: res.status, rows: await res.json() } : { status: res.status, rows: [] };
    }, target.url);
  const toast = () => page.textContent("#toast");
  const syncHeader = () => page.textContent("[data-sync-status]");
  const importFixture = async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15000 }),
      page.click("[data-action='import-cloud-backup']"),
    ]);
    await chooser.setFiles({ name: "copia-prueba.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(FIXTURE)) });
  };

  try {
    // 1. Autenticación con el formulario real del CRM (usuario de staging con crm_role = admin).
    await page.goto(crmBase, { waitUntil: "load" });
    await page.fill("form[data-form='supabase-login'] input[name='email']", process.env.STAGING_EMAIL);
    await page.fill("form[data-form='supabase-login'] input[name='password']", process.env.STAGING_PASSWORD);
    await page.click("form[data-form='supabase-login'] button[type='submit']");
    await page.waitForSelector("[data-sync-status]", { timeout: 20000 });
    check("autenticación: el administrador entra y ve el panel", true);

    // 2. Permisos: sin sesión (solo clave anónima) no se leen filas de crm_records.
    const anon = await fetch(`${target.url}/rest/v1/crm_records?select=id&limit=5`, {
      headers: { apikey: target.anonKey, Authorization: `Bearer ${target.anonKey}` },
    });
    const anonRows = anon.ok ? await anon.json() : [];
    check("permisos: la clave anónima no lee crm_records", !(anon.ok && anonRows.length > 0), `HTTP ${anon.status}, filas ${anonRows.length}`);

    // 3. Persistencia: importar la copia ficticia confirma 4 registros en la nube.
    await importFixture();
    await page.waitForFunction(() => /Confirmado por Supabase/.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 20000 });
    // Idempotente entre ejecuciones: nuevos + ya existentes deben sumar los 4 registros de la copia.
    const m = (await toast()).match(/(\d+) nuevos y (\d+) ya existían/);
    check("persistencia: importación confirmada por Supabase (4 registros de la copia)", Boolean(m) && Number(m[1]) + Number(m[2]) === EXPECTED_IMPORT, (await toast()).trim());

    // 4. Lectura: crm_records devuelve exactamente los registros esperados y con sus tipos.
    const afterImport = await remoteRows();
    const keys = new Set(afterImport.rows.map((row) => `${row.kind}:${row.local_id}`));
    const missing = FIXTURE_KEYS.filter((key) => !keys.has(key));
    check("lectura: crm_records contiene los 4 registros de la copia", missing.length === 0, missing.length ? `faltan ${missing.join(", ")}` : `filas ${afterImport.rows.length}`);

    // 5. Importación repetida: no inserta ni duplica nada.
    await importFixture();
    await page.waitForFunction(() => /Confirmado por Supabase/.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 20000 });
    const repeated = await remoteRows();
    check("importación repetida: 0 nuevos y sin duplicados", /0 nuevos/.test(await toast()) && new Set(repeated.rows.map((row) => `${row.kind}:${row.local_id}`)).size === repeated.rows.length, `filas ${repeated.rows.length}`);

    // 6. Fallo de red: un cambio local real intenta sincronizar y la petición se corta.
    // Se añade un cliente real local (no demo) para que haya algo que enviar.
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("legalprevent-crm-v1"));
      raw.clients.push({ id: "cli-local-1", businessName: "Cliente local de prueba", taxId: "B11111111", primaryContact: "Local", email: "local@prueba.test", plan: "Pyme" });
      localStorage.setItem("legalprevent-crm-v1", JSON.stringify(raw));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-sync-status]", { timeout: 20000 });
    await context.route("**/rest/v1/crm_records**", (route) => route.abort());
    await page.click("[data-action='clear-demo-data']");
    await page.waitForFunction(() => /No se ha sincronizado|conexión/.test(document.querySelector("[data-sync-status]")?.textContent || ""), null, { timeout: 15000 });
    const localAfterFailure = await page.evaluate(() => JSON.parse(localStorage.getItem("legalprevent-crm-v1")));
    check("fallo de red: la cabecera muestra error y el cambio local se conserva", /No se ha sincronizado|conexión/.test(await syncHeader()) && !/Sincronizado con la nube/.test(await syncHeader()) && localAfterFailure.leads.every((lead) => lead.isDemo !== true), (await syncHeader()).trim());

    // 7. Recuperación: restablecer la red y reintentar. La nube conserva lo importado, sin duplicar.
    await context.unroute("**/rest/v1/crm_records**");
    await page.click("[data-action='retry-cloud-sync']");
    await page.waitForFunction(() => /Sincronizado con la nube/.test(document.querySelector("[data-sync-status]")?.textContent || ""), null, { timeout: 20000 });
    const recovered = await remoteRows();
    const uniqueKeys = new Set(recovered.rows.map((row) => `${row.kind}:${row.local_id}`));
    check("recuperación: sincronizado y sin duplicados (cliente local presente)", uniqueKeys.size === recovered.rows.length && uniqueKeys.has("client:cli-local-1"), `filas ${recovered.rows.length}`);

    // 8. Retirada de consentimiento y eliminación a nivel de función: idempotencia y estados.
    const unknown = await page.evaluate(() => window.LegalPreventSupabase.withdrawCommercialConsent("00000000-0000-0000-0000-000000000000"));
    check("retirada: un lead inexistente devuelve not_found (la UI no lo trata como éxito)", unknown.status === "not_found", JSON.stringify(unknown));
    const erase1 = await page.evaluate(() => window.LegalPreventSupabase.eraseContact("nadie@prueba.test", "prueba de integración"));
    const erase2 = await page.evaluate(() => window.LegalPreventSupabase.eraseContact("nadie@prueba.test", "prueba de integración"));
    check("eliminación: repetirla no cambia el resultado", erase1.leads_deleted === 0 && erase2.leads_deleted === 0, `${JSON.stringify(erase1)} / ${JSON.stringify(erase2)}`);
    console.log("PEND fallo parcial en UI (Supabase confirma y el guardado local falla) para eliminación y retirada: requiere un lead real de staging y se verifica a mano según docs/crm-staging-integracion.md.");

    check("sin errores de página", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (error) {
    check("ejecución completa sin excepciones", false, error.message);
  } finally {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(RESULTS_DIR, "panel.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(RESULTS_DIR, "resultados.json"), JSON.stringify({ target: target.url, when: new Date().toISOString(), results, pageErrors, dialogs }, null, 2));
    await browser.close();
    server.close();
  }
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\nRESULTADO: ${results.length - failed}/${results.length} comprobaciones correctas. Resultados en ${RESULTS_DIR}`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}

module.exports = { assertStagingTarget, STAGING_URL, PRODUCTION_REF };
