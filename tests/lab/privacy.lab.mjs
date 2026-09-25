// PR1c de extremo a extremo: el CRM (bridge real con sesión de administrador)
// contra PostgREST y la base con las migraciones de la rama.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN, SERVICE } from "./jwt.mjs";
import { ROOT, loadBridge, psql, reset, rpc } from "./helpers.mjs";

const crm = (session = AUTHENTICATED) => loadBridge(readFileSync(`${ROOT}supabase-bridge.js`, "utf8"), { session }).api;
const publishedCrm = () => loadBridge(readFileSync(`${process.env.LAB_PUBLISHED_DIR}/supabase-bridge.js`, "utf8"), { session: AUTHENTICATED }).api;
const submit = (email, extra = {}) => rpc("submit_lead", { p_payload: { email, privacy_accepted: true, ...extra } });

beforeEach(async () => {
  await reset();
  psql("lab", "delete from private.erasure_log; delete from private.retention_log; update private.settings set value = '{\"enabled\": false, \"months\": 12}' where key = 'retention';");
});

test("supresión desde el CRM: borra leads, diagnósticos y consentimientos y deja constancia sin el email", async () => {
  await submit("ana@example.com", { commercial_consent: true });
  await submit("ANA@example.com", { source: "diagnostic_completed" });
  await rpc("submit_diagnostic", { p_payload: { email: "ana@example.com", privacy_accepted: true } });
  await submit("otro@example.com");
  const result = await crm().eraseContact("ana@example.com", "Solicitud del interesado");
  assert.deepEqual(result, { leads_deleted: 2, diagnostics_deleted: 1 });
  assert.equal(psql("lab", "select count(*) from public.leads where email = 'ana@example.com'"), "0");
  assert.equal(psql("lab", "select count(*) from public.diagnostics"), "0");
  assert.equal(psql("lab", "select count(*) from public.leads"), "1", "no toca otros contactos");
  assert.equal(psql("lab", "select count(*) from private.consent_events e join public.leads l on l.id = e.lead_id"), "1", "solo quedan los consentimientos del otro contacto");
  assert.equal(psql("lab", "select count(*) from private.erasure_log where email_hash !~ '@' and reason = 'Solicitud del interesado'"), "1");
});

test("supresión: un usuario sin rol de administrador recibe un mensaje claro y no borra nada", async () => {
  await submit("ana@example.com");
  await assert.rejects(crm(AUTHENTICATED_NO_ADMIN).eraseContact("ana@example.com", "motivo"), /no tiene permiso de administrador/);
  assert.equal(psql("lab", "select count(*) from public.leads"), "1");
  assert.equal((await rpc("crm_erase_contact", { p_email: "ana@example.com", p_reason: "motivo" }, ANON)).code, "42501");
});

test("retirada del consentimiento desde el CRM: queda registrada y el CRM la ve al sincronizar", async () => {
  const { id } = await submit("ana@example.com", { commercial_consent: true });
  assert.deepEqual(await crm().withdrawCommercialConsent(id), { status: "withdrawn" });
  assert.deepEqual(await crm().withdrawCommercialConsent(id), { status: "not_consented" });
  const [row] = await crm().fetchLeads();
  assert.equal(row.commercial_consent, false);
  assert.ok(row.commercial_consent_withdrawn_at);
  assert.equal(psql("lab", `select string_agg(action, ',' order by id) from private.consent_events where lead_id = '${id}' and kind = 'commercial'`), "granted,withdrawn");
});

test("vista previa de la conservación: solo recuentos, desactivada por defecto", async () => {
  psql("lab", `insert into public.leads (email, created_at, updated_at) values ('viejo@example.com', now() - interval '2 years', now() - interval '2 years')`);
  const preview = await crm().retentionPreview();
  assert.equal(preview.enabled, false);
  assert.equal(preview.months, 12);
  assert.equal(preview.leads, 1);
  assert.doesNotMatch(JSON.stringify(preview), /@/);
});

test("ejecución de la conservación: desactivada no borra; activada borra solo lo caducado", async () => {
  psql("lab", `insert into public.leads (email, created_at, updated_at) values ('viejo@example.com', now() - interval '2 years', now() - interval '2 years')`);
  await submit("nuevo@example.com");
  assert.equal((await rpc("retention_run", {}, SERVICE)).status, "disabled");
  assert.equal(psql("lab", "select count(*) from public.leads"), "2");
  psql("lab", `update private.settings set value = '{"enabled": true, "months": 12}' where key = 'retention'`);
  const run = await rpc("retention_run", {}, SERVICE);
  assert.deepEqual([run.status, run.leads_deleted], ["done", 1]);
  assert.equal(psql("lab", "select email from public.leads"), "nuevo@example.com");
  assert.equal((await rpc("retention_run", {}, AUTHENTICATED)).code, "42501", "el CRM no puede ejecutarla");
});

test("el CRM publicado sigue funcionando sobre la base con PR1c", async () => {
  await submit("ana@example.com");
  const rows = await publishedCrm().fetchLeads();
  assert.equal(rows.length, 1);
});
