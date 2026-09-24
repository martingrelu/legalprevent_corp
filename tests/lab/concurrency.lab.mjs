// Concurrencia real (PostgREST con pool de conexiones independientes a
// Postgres), tope horario, idempotencia y plazos.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callFunction, emails, mode, newLead, psql, psqlAsync, reset, rpc, service, tally } from "./helpers.mjs";

beforeEach(() => reset());

const claim = (id, kind = "new_lead", cap = 1000) =>
  service("claim_lead_notification", { p_lead_id: id, p_kind: kind, p_hourly_cap: cap });

test("A. 50 reclamaciones simultáneas del mismo lead: exactamente 1", async () => {
  const id = await newLead();
  const out = tally((await Promise.all(Array.from({ length: 50 }, () => claim(id)))).map((r) => r.status));
  assert.deepEqual(out, { claimed: 1, not_eligible: 49 });
});

test("B. 60 reclamaciones simultáneas con tope 10: exactamente 10", async () => {
  const ids = await Promise.all(Array.from({ length: 60 }, (_, i) => newLead(i)));
  const out = tally((await Promise.all(ids.map((id) => claim(id, "new_lead", 10)))).map((r) => r.status));
  assert.deepEqual(out, { claimed: 10, throttled: 50 });
  assert.equal(psql("lab", "select count(*) from public.leads where notified_at is not null"), "10");
});

test("B2. los dos tipos de aviso comparten el tope", async () => {
  const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => newLead(i, { source: "diagnostic_completed" })));
  await Promise.all(ids.map((id) => rpc("request_lead_demo", { p_lead_id: id })));
  const out = await Promise.all(ids.flatMap((id) => ["new_lead", "demo_request"].map((kind) => claim(id, kind, 15))));
  assert.equal(tally(out.map((r) => r.status)).claimed, 15);
});

test("B3. sin el advisory lock el tope se supera (el bloqueo es necesario)", async () => {
  const sig = "public.claim_lead_notification(uuid,text,integer)";
  psql("lab", `create table _lab_lock_bak as select pg_get_functiondef('${sig}'::regprocedure) body;
    do $m$ declare v text; begin
      select replace(body, $f$perform pg_advisory_xact_lock(hashtext('legalprevent.lead_notification'));$f$, 'perform pg_sleep(0.05);') into v from _lab_lock_bak;
      execute v; end $m$;`);
  try {
    const ids = await Promise.all(Array.from({ length: 60 }, (_, i) => newLead(i)));
    const claimed = (await Promise.all(ids.map((id) => claim(id, "new_lead", 10)))).filter((r) => r.status === "claimed").length;
    assert.ok(claimed > 10, `sin bloqueo se esperaba superar el tope y se reclamaron ${claimed}`);
  } finally {
    psql("lab", `do $m$ declare v text; begin select body into v from _lab_lock_bak; execute v; end $m$; drop table _lab_lock_bak;`);
  }
});

test("B4. sesiones psql independientes: la segunda espera al bloqueo y no duplica", async () => {
  const id = await newLead();
  const first = psqlAsync("lab", `begin; set local role service_role;
    select (public.claim_lead_notification('${id}', 'new_lead', 100))->>'status'; select pg_sleep(2); commit;`);
  await new Promise((r) => setTimeout(r, 500));
  const started = Date.now();
  const second = await psqlAsync("lab", `begin; set local role service_role;
    select (public.claim_lead_notification('${id}', 'new_lead', 100))->>'status'; commit;`);
  const waited = Date.now() - started;
  assert.match(await first, /claimed/);
  assert.match(second, /not_eligible/);
  assert.ok(waited > 1000, `la segunda sesión debería esperar al bloqueo (esperó ${waited} ms)`);
});

test("C. 30 llamadas simultáneas a la función para el mismo lead: 1 email interno", async () => {
  const id = await newLead();
  const out = await Promise.all(Array.from({ length: 30 }, () => callFunction({ leadId: id }).then((r) => r.json())));
  const { delivered } = await emails();
  assert.equal(delivered.length, 1);
  assert.equal(out.filter((r) => r.notified).length, 1);
  assert.deepEqual(delivered[0].to, ["interno@lab.invalid"]);
});

test("D. 40 leads en paralelo por la función con tope 10: 10 emails", async () => {
  await mode({ cap: 10 });
  const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => newLead(i)));
  const statuses = tally(await Promise.all(ids.map((id) => callFunction({ leadId: id }).then((r) => r.status))));
  assert.equal((await emails()).delivered.length, 10);
  assert.deepEqual(statuses, { 200: 10, 202: 30 });
});

test("E. Resend acepta pero la respuesta se pierde: el reintento no duplica", async () => {
  const id = await newLead();
  await mode({ resend: "accept-then-timeout" });
  const first = await callFunction({ leadId: id });
  assert.equal(first.status, 502);
  assert.equal(psql("lab", `select notified_at is null from public.leads where id = '${id}'`), "t");
  await mode({ resend: "ok" });
  assert.equal((await callFunction({ leadId: id })).status, 200);
  const { delivered, attempts } = await emails();
  assert.equal(delivered.length, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.equal(attempts[0].key, `lead-notification/new_lead/${id}`);
});

test("F. Resend 500: se libera; el reintento envía; un tercer intento no reenvía", async () => {
  const id = await newLead();
  await mode({ resend: "fail500" });
  assert.equal((await callFunction({ leadId: id })).status, 502);
  await mode({ resend: "ok" });
  assert.equal((await callFunction({ leadId: id })).status, 200);
  assert.equal((await (await callFunction({ leadId: id })).json()).notified, false);
  assert.equal((await emails()).delivered.length, 1);
});

test("G. id inventado o demo sobre un lead que no es de diagnóstico: sin aviso", async () => {
  const fake = await (await callFunction({ leadId: "11111111-2222-4333-8444-555555555555" })).json();
  const id = await newLead(0, { source: "demo_requested" });
  assert.equal(await rpc("request_lead_demo", { p_lead_id: id }), false);
  const demo = await (await callFunction({ leadId: id, kind: "demo_request" })).json();
  assert.equal(fake.notified, false);
  assert.equal(demo.notified, false);
  assert.equal((await emails()).delivered.length, 0);
});

test("H. lead de hace 20 minutos: sin aviso", async () => {
  const id = await newLead();
  psql("lab", `update public.leads set created_at = now() - interval '20 minutes' where id = '${id}'`);
  assert.equal((await (await callFunction({ leadId: id })).json()).notified, false);
});

test("I. la función rechaza destinatarios arbitrarios y orígenes no permitidos", async () => {
  const attack = await callFunction({ lead: { email: "victima@example.com" }, to: "victima@example.com" });
  assert.equal(attack.status, 400);
  const evil = await callFunction({ leadId: await newLead() }, "https://evil.example");
  assert.equal(evil.status, 403);
  assert.equal((await emails()).attempts.length, 0);
});
