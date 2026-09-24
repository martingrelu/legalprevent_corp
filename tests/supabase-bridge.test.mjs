// Pruebas del bridge del navegador (PR0): el aviso interno solo recibe el id
// del lead y ningún fallo deja datos personales en el navegador.
// Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const bridgeSource = readFileSync(new URL("../supabase-bridge.js", import.meta.url), "utf8");
const LEAD_ID = "3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f";

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data,
    writes,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key),
  };
}

function loadBridge({ submitLeadStatus = 200, submitDiagnosticStatus = 200, emailStatus = 200, demoMarked = true, rateLimited = false, storage } = {}) {
  const calls = [];
  const localStorage = storage || createStorage();
  const sessionStorage = createStorage();
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (rateLimited && /\/rpc\/submit_(lead|diagnostic)$/.test(String(url))) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 200 });
    }
    if (String(url).endsWith("/rpc/submit_lead")) {
      return submitLeadStatus === 200
        ? new Response(JSON.stringify({ id: LEAD_ID }), { status: 200 })
        : new Response("error", { status: submitLeadStatus });
    }
    if (String(url).endsWith("/rpc/submit_diagnostic")) {
      return new Response(JSON.stringify({ id: "d1" }), { status: submitDiagnosticStatus });
    }
    if (String(url).endsWith("/rpc/request_lead_demo")) {
      return new Response(JSON.stringify(demoMarked), { status: 200 });
    }
    if (String(url).endsWith("/functions/v1/smooth-action")) {
      return new Response(JSON.stringify({ ok: emailStatus === 200 }), { status: emailStatus });
    }
    return new Response("no encontrado", { status: 404 });
  };
  const window = {
    LEGAL_PREVENT_SUPABASE: { url: "https://proyecto.supabase.co", anonKey: "anon" },
    location: { href: "https://legalprevent.com/", origin: "https://legalprevent.com" },
  };
  const context = vm.createContext({
    window,
    fetch,
    localStorage,
    sessionStorage,
    console: { warn() {}, info() {}, error() {}, log() {} },
    Response,
    JSON,
    Date,
    Math,
    Number,
    String,
    Boolean,
    encodeURIComponent,
  });
  vm.runInContext(bridgeSource, context);
  return { api: window.LegalPreventSupabase, calls, localStorage, sessionStorage };
}

const demoInput = {
  eventType: "demo_requested",
  leadStage: "demo_requested_from_landing",
  lead: { email: "ana@empresa.es", companyName: "Lead web - Empresa" },
  form: { email: "ana@empresa.es", privacy: "on" },
  page: "https://legalprevent.com/",
};

test("createLead guarda en Supabase y el aviso interno recibe solo el leadId", async () => {
  const { api, calls } = loadBridge();
  const result = await api.createLead(demoInput);
  assert.equal(result.ok, true);
  const emailCall = calls.find((call) => call.url.endsWith("/functions/v1/smooth-action"));
  assert.ok(emailCall, "debe pedirse el aviso interno");
  assert.deepEqual(emailCall.body, { leadId: LEAD_ID, kind: "new_lead" });
  assert.equal(result.record.id, LEAD_ID);
});

const submittedLead = (calls) =>
  calls.find((call) => call.url.endsWith("/rpc/submit_lead")).body.p_payload;

test("privacidad y comunicaciones comerciales se transmiten por separado (formulario)", async () => {
  const cases = [
    [{ privacy: "on" }, { privacy_accepted: true, commercial_consent: false }],
    [{ privacy: "on", commercial: "on" }, { privacy_accepted: true, commercial_consent: true }],
  ];
  for (const [form, expected] of cases) {
    const { api, calls } = loadBridge();
    await api.createLead({ ...demoInput, form: { email: "ana@empresa.es", ...form } });
    const record = submittedLead(calls);
    assert.equal(record.privacy_accepted, expected.privacy_accepted);
    assert.equal(record.commercial_consent, expected.commercial_consent);
  }
});

test("privacidad y comunicaciones comerciales se transmiten por separado (diagnóstico)", async () => {
  const cases = [
    [{ privacyAccepted: true, commercialConsent: false }, { privacy_accepted: true, commercial_consent: false }],
    [{ privacyAccepted: true, commercialConsent: true }, { privacy_accepted: true, commercial_consent: true }],
  ];
  for (const [flags, expected] of cases) {
    const { api, calls } = loadBridge();
    await api.createLead({ eventType: "diagnostic_completed", lead: { email: "ana@empresa.es" }, ...flags });
    const record = submittedLead(calls);
    assert.equal(record.privacy_accepted, expected.privacy_accepted);
    assert.equal(record.commercial_consent, expected.commercial_consent);
  }
});

test("valores ambiguos no cuentan como consentimiento", async () => {
  const { api, calls } = loadBridge();
  await api.createLead({
    eventType: "diagnostic_completed",
    lead: { email: "ana@empresa.es" },
    privacyAccepted: true,
    commercialConsent: "false",
    form: { commercial: "yes" }
  });
  assert.equal(submittedLead(calls).commercial_consent, false);
});

test("sin aceptar la política de privacidad no se envía ningún dato", async () => {
  const { api, calls } = loadBridge();
  const lead = await api.createLead({ ...demoInput, form: { email: "ana@empresa.es", commercial: "on" } });
  const diagnostic = await api.createDiagnostic({ payload: { company: { email: "ana@empresa.es" } } });
  assert.equal(lead.ok, false);
  assert.equal(lead.reason, "privacy_required");
  assert.equal(diagnostic.reason, "privacy_required");
  assert.equal(calls.length, 0);
});

test("la demo tras el diagnóstico marca el mismo lead y pide aviso de tipo demo", async () => {
  const { api, calls } = loadBridge();
  const result = await api.requestLeadDemo(LEAD_ID);
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.url.endsWith("/rpc/submit_lead")), false, "no crea otro lead");
  assert.deepEqual(calls.find((call) => call.url.endsWith("/rpc/request_lead_demo")).body, { p_lead_id: LEAD_ID });
  assert.deepEqual(calls.find((call) => call.url.endsWith("/smooth-action")).body, { leadId: LEAD_ID, kind: "demo_request" });
});

test("si el servidor no acepta la demo, no se pide aviso", async () => {
  const { api, calls } = loadBridge({ demoMarked: false });
  const result = await api.requestLeadDemo(LEAD_ID);
  assert.equal(result.ok, false);
  assert.equal(calls.some((call) => call.url.endsWith("/smooth-action")), false);
});

test("si falla el alta del lead no se pide aviso ni se guarda nada en el navegador", async () => {
  const { api, calls, localStorage, sessionStorage } = loadBridge({ submitLeadStatus: 500 });
  const result = await api.createLead(demoInput);
  assert.equal(result.ok, false);
  assert.equal(calls.some((call) => call.url.endsWith("/smooth-action")), false);
  assert.deepEqual(localStorage.writes, []);
  assert.deepEqual(sessionStorage.writes, []);
});

test("si falla el aviso interno el lead sigue guardado y no se escribe en el navegador", async () => {
  const { api, localStorage } = loadBridge({ emailStatus: 500 });
  const result = await api.createLead(demoInput);
  assert.equal(result.ok, true);
  assert.equal(result.email.ok, false);
  assert.deepEqual(localStorage.writes, []);
});

test("si falla el diagnóstico no se guarda nada en el navegador", async () => {
  const { api, localStorage } = loadBridge({ submitDiagnosticStatus: 500 });
  const result = await api.createDiagnostic({ payload: { company: { email: "ana@empresa.es" } }, privacyAccepted: true });
  assert.equal(result.ok, false);
  assert.deepEqual(localStorage.writes, []);
});

test("elimina al cargar la cola antigua de leads pendientes con datos personales", () => {
  const storage = createStorage({
    lp_pending_supabase_leads: JSON.stringify([{ payload: { email: "ana@empresa.es" } }]),
    "legalprevent-cookie-consent": "{}",
  });
  loadBridge({ storage });
  assert.equal(storage.getItem("lp_pending_supabase_leads"), null);
  assert.equal(storage.getItem("legalprevent-cookie-consent"), "{}", "no toca otras claves");
});

test("sin configuración de Supabase no se guarda nada en el navegador", async () => {
  const storage = createStorage();
  const context = vm.createContext({
    window: { location: { href: "https://legalprevent.com/" } },
    fetch: async () => { throw new Error("no debe llamarse"); },
    localStorage: storage,
    sessionStorage: createStorage(),
    console: { warn() {} },
    JSON, Date, Math, Number, String, Boolean,
  });
  vm.runInContext(bridgeSource, context);
  const result = await context.window.LegalPreventSupabase.createLead(demoInput);
  assert.equal(result.ok, false);
  assert.deepEqual(storage.writes, []);
});

test("envía la versión de la política de privacidad y, solo si hay consentimiento, la de comunicaciones", async () => {
  const sin = loadBridge();
  await sin.api.createLead(demoInput);
  const record = submittedLead(sin.calls);
  assert.equal(record.privacy_policy_version, "2026-06-04");
  assert.equal("commercial_consent_version" in record, false);

  const con = loadBridge();
  await con.api.createLead({ ...demoInput, form: { ...demoInput.form, commercial: "on" } });
  assert.equal(submittedLead(con.calls).commercial_consent_version, "2026-06-04");

  const diag = loadBridge();
  await diag.api.createDiagnostic({ payload: { company: { email: "ana@empresa.es" } }, privacyAccepted: true });
  assert.equal(diag.calls.find((call) => call.url.endsWith("/rpc/submit_diagnostic")).body.p_payload.privacy_policy_version, "2026-06-04");
});

test("límite superado: informa rate_limited, no pide aviso y no guarda nada en el navegador", async () => {
  const { api, calls, localStorage } = loadBridge({ rateLimited: true });
  const lead = await api.createLead(demoInput);
  const diagnostic = await api.createDiagnostic({ payload: { company: { email: "ana@empresa.es" } }, privacyAccepted: true });
  assert.deepEqual([lead.ok, lead.reason], [false, "rate_limited"]);
  assert.deepEqual([diagnostic.ok, diagnostic.reason], [false, "rate_limited"]);
  assert.equal(calls.some((call) => call.url.endsWith("/smooth-action")), false);
  assert.deepEqual(localStorage.writes, []);
});
