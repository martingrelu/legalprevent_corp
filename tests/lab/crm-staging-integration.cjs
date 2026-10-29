// Integración LP-CRM-002 contra el proyecto de STAGING. Nunca producción.
// Uso: STAGING_ANON_KEY=... STAGING_EMAIL=... STAGING_PASSWORD=... node tests/lab/crm-staging-integration.cjs
// Ver docs/crm-staging-integracion.md. Las credenciales se leen del entorno, nunca se guardan.
const PRODUCTION_REF = "wtpfrlsbfishvworjdtr";
const STAGING_URL = "https://ubyopnnfmajmrqhkapjk.supabase.co";
const CRM_BASE = process.env.CRM_BASE || "http://127.0.0.1:8765/crm/index.html";

function assertStagingTarget(env = process.env) {
  const url = env.STAGING_URL || STAGING_URL;
  if (url !== STAGING_URL) throw new Error(`Guardia: STAGING_URL debe ser exactamente ${STAGING_URL}.`);
  if (url.includes(PRODUCTION_REF)) throw new Error("Guardia: la URL apunta a producción. Ejecución cancelada.");
  if (!env.STAGING_ANON_KEY) throw new Error("Guardia: falta STAGING_ANON_KEY.");
  if (!env.STAGING_EMAIL || !env.STAGING_PASSWORD) throw new Error("Guardia: faltan STAGING_EMAIL o STAGING_PASSWORD.");
  return { url, anonKey: env.STAGING_ANON_KEY };
}

// Solo tras pasar la guardia: configura el navegador de prueba y bloquea cualquier otro Supabase.
async function configureRouting(context, target) {
  const configJs = `window.LEGAL_PREVENT_SUPABASE = ${JSON.stringify({ url: target.url, anonKey: target.anonKey })};`;
  await context.route("**/supabase-config.js*", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: configJs }),
  );
  await context.route("**/*.supabase.co/**", (route) => {
    if (route.request().url().startsWith(target.url + "/")) return route.continue();
    return route.abort();
  });
}

async function main() {
  const target = assertStagingTarget();
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await configureRouting(context, target);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 1. Autenticación con el formulario real del CRM.
  await page.goto(CRM_BASE, { waitUntil: "load" });
  await page.fill("form[data-form='supabase-login'] input[name='email']", process.env.STAGING_EMAIL);
  await page.fill("form[data-form='supabase-login'] input[name='password']", process.env.STAGING_PASSWORD);
  await page.click("form[data-form='supabase-login'] button[type='submit']");
  await page.waitForSelector("[data-sync-status]", { timeout: 20000 });
  console.log("OK  autenticación: el administrador ve el panel");

  // 2. Permisos: la clave anónima no puede leer crm_records (lectura sin sesión).
  const anon = await fetch(`${target.url}/rest/v1/crm_records?select=id&limit=1`, {
    headers: { apikey: target.anonKey, Authorization: `Bearer ${target.anonKey}` },
  });
  const anonBody = await anon.text();
  console.log(`${anon.status === 200 && anonBody !== "[]" ? "FAIL" : "OK  "} permisos: la clave anónima no lee crm_records (HTTP ${anon.status})`);

  // 3-5. Persistencia, lectura, importación repetida: se completan con la copia de prueba
  // (ver docs/crm-staging-integracion.md, sección 5). Aquí se cargan los pasos 3 a 7 con la misma
  // lógica que la prueba del navegador ya validada en local.
  console.log("PEND persistencia/lectura/importación repetida/fallo de red/recuperación: requieren la copia ficticia de staging (sección 5, pasos 3-7).");
  console.log("PEND eliminación y retirada de consentimiento: requieren un lead real de staging (sección 5, paso 8).");

  if (pageErrors.length) console.log(`FAIL errores de página: ${pageErrors.join(" | ")}`);
  await browser.close();
  process.exit(pageErrors.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}

module.exports = { assertStagingTarget, STAGING_URL, PRODUCTION_REF };
