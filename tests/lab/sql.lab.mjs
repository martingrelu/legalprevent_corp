// Migraciones, verificadores SQL, mutaciones de seguridad y permisos efectivos.
//   lab_old = producción actual (origin/main: PR0 y PR1a desplegados)
//   lab     = producción + migraciones de la rama
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT, VERIFY_PR1A, VERIFY_PR1B, psql, psqlFile, reset } from "./helpers.mjs";

const PR1A = [
  `${ROOT}supabase/migrations/20260925_crm_admin_policies.sql`,
  `${ROOT}supabase/migrations/20260925_public_limits_consent.sql`,
];
const PR0_MIGRATION = `${ROOT}supabase/migrations/20260924_lead_notification_claim.sql`;

const result = (db, file) => {
  const out = psqlFile(db, file, { allowError: true });
  return (out.match(/(FALLO: [^\n]*|OK: [^\n]*)/) || [out.slice(0, 300)])[0];
};
const verifyPr1a = () => result("lab", VERIFY_PR1A);

// Sustituye temporalmente el cuerpo de una función y lo restaura al terminar.
function withFunctionMutation(signature, from, to, fn) {
  psql("lab", `create table if not exists _lab_bak (sig text primary key, body text);
    insert into _lab_bak values ('${signature}', pg_get_functiondef('${signature}'::regprocedure))
    on conflict (sig) do update set body = excluded.body;`);
  psql("lab", `do $m$ declare v text; begin
    select replace(body, $f$${from}$f$, $t$${to}$t$) into v from _lab_bak where sig = '${signature}';
    if v = (select body from _lab_bak where sig = '${signature}') then raise exception 'mutación no aplicada'; end if;
    execute v; end $m$;`);
  try {
    return fn();
  } finally {
    psql("lab", `do $m$ declare v text; begin select body into v from _lab_bak where sig = '${signature}'; execute v; end $m$;
      drop table _lab_bak;`);
  }
}

// verify_pr0_migration.sql es histórico: su bloque 10 comprueba la
// compatibilidad temporal que PR1a retiró. Producción se verifica ahora con el
// verificador de PR1a.
test("la réplica de producción supera verify_pr1a_migration.sql", () => {
  assert.equal(result("lab_old", VERIFY_PR1A), "OK: verificación PR1a superada");
});

test("las migraciones de PR1a se pueden reaplicar (idempotentes)", async () => {
  await reset();
  for (const file of PR1A) psqlFile("lab", file);
  for (const file of PR1A) psqlFile("lab", file);
});

test("verify_pr1a_migration.sql supera todos los bloques", () => {
  assert.equal(verifyPr1a(), "OK: verificación PR1a superada");
});

test("el verificador de PR1a detecta vulnerabilidades reintroducidas", () => {
  psql("lab", "grant usage on schema private to anon; grant select on private.settings to anon;");
  try {
    assert.match(verifyPr1a(), /FALLO: anon pudo leer private.settings/);
  } finally {
    psql("lab", "revoke select on private.settings from anon; revoke usage on schema private from anon;");
  }

  psql("lab", "grant select on public.payments to anon;");
  try {
    assert.match(verifyPr1a(), /FALLO: anon pudo leer payments/);
  } finally {
    psql("lab", "revoke select on public.payments from anon;");
  }

  psql("lab", "grant update on public.leads to authenticated;");
  try {
    assert.match(verifyPr1a(), /FALLO: el CRM pudo modificar privacy_accepted_at/);
  } finally {
    psql("lab", `revoke update on public.leads from authenticated;
      grant update (source, stage, company_name, contact_name, email, phone, sector, employees,
        status, priority, score, risk_score, recommended_plan, page_url, payload,
        lead_type, zone, demo_at, next_action_at, lost_reason) on public.leads to authenticated;`);
  }

  withFunctionMutation("private.rate_hit(text,interval,integer)", "return v_hits <= p_limit;", "return true;", () =>
    assert.match(verifyPr1a(), /FALLO: el límite por email no se aplicó/));

  withFunctionMutation("private.client_ip()",
    "reverse(split_part(reverse(v_headers ->> 'x-forwarded-for'), ',', 1))",
    "split_part(v_headers ->> 'x-forwarded-for', ',', 1)", () =>
      assert.match(verifyPr1a(), /FALLO: IP mal extraída/));

  // Reintroduce la compatibilidad temporal de PR0 (submit_diagnostic de PR0).
  const pr0 = readFileSync(PR0_MIGRATION, "utf8");
  const pr0Diagnostic = pr0.match(/create or replace function public\.submit_diagnostic[\s\S]*?\n\$\$;/)[0];
  psql("lab", `create table _lab_diag_bak as select pg_get_functiondef('public.submit_diagnostic(jsonb)'::regprocedure) body;`);
  try {
    psql("lab", pr0Diagnostic);
    assert.match(verifyPr1a(), /FALLO:/);
  } finally {
    psql("lab", `do $m$ declare v text; begin select body into v from _lab_diag_bak; execute v; end $m$; drop table _lab_diag_bak;`);
  }

  assert.equal(verifyPr1a(), "OK: verificación PR1a superada");
});

test("permisos efectivos tras PR1a", () => {
  const privileges = (role, table) =>
    psql("lab", `select coalesce(string_agg(p, ',' order by p), '') from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
      where has_table_privilege('${role}', 'public.${table}', p)`);
  for (const table of ["leads", "diagnostics", "checkout_sessions", "subscriptions", "payments"]) {
    assert.equal(privileges("anon", table), "", `anon no debe tener privilegios en ${table}`);
  }
  for (const table of ["diagnostics", "checkout_sessions", "subscriptions", "payments"]) {
    assert.equal(privileges("authenticated", table), "SELECT", `authenticated solo lee ${table}`);
  }
  assert.equal(privileges("authenticated", "leads"), "INSERT,SELECT", "authenticated: UPDATE solo por columnas");
  assert.equal(psql("lab", "select has_column_privilege('authenticated','public.leads','status','UPDATE')"), "t");
  for (const column of ["privacy_accepted_at", "privacy_policy_version", "commercial_consent", "commercial_consent_at", "privacy_review_required", "notified_at", "demo_requested_at"]) {
    assert.equal(psql("lab", `select has_column_privilege('authenticated','public.leads','${column}','UPDATE')`), "f", column);
  }
  assert.equal(psql("lab", "select has_schema_privilege('anon','private','USAGE') or has_schema_privilege('authenticated','private','USAGE')"), "f");
  const fns = Object.fromEntries(
    psql("lab", `select proname, has_function_privilege('anon', oid, 'EXECUTE') from pg_proc
      where pronamespace = 'public'::regnamespace and proname in
      ('submit_lead','submit_diagnostic','request_lead_demo','claim_lead_notification','is_crm_admin','set_updated_at')`)
      .split("\n").map((line) => line.split("|")),
  );
  assert.deepEqual(fns, {
    submit_lead: "t",
    submit_diagnostic: "t",
    request_lead_demo: "t",
    claim_lead_notification: "f",
    is_crm_admin: "f",
    set_updated_at: "f",
  });
});

test("pr0-snapshot.sql y pr1-inventory.sql se ejecutan en la réplica de producción sin modificar nada", () => {
  const before = psql("lab_old", "select md5(coalesce(string_agg(t::text, ','), '')) from (select * from public.leads order by id) t");
  const snapshot = psqlFile("lab_old", `${ROOT}supabase/deploy/pr0-snapshot.sql`);
  assert.match(snapshot, /postgres miembro de anon\|true/);
  const inventory = psqlFile("lab_old", `${ROOT}supabase/deploy/pr1-inventory.sql`);
  assert.match(inventory, /tabla payments\|rls=true anon=- auth=S /);
  assert.equal(psql("lab_old", "select md5(coalesce(string_agg(t::text, ','), '')) from (select * from public.leads order by id) t"), before);
});

// ---------------------------------------------------------------------------
// PR1b · contabilidad del agente
// ---------------------------------------------------------------------------
const PR1B = `${ROOT}supabase/migrations/20260926_agent_budget.sql`;
const PR1B_ROLLBACK = `${ROOT}supabase/rollback/20260926_agent_budget_down.sql`;
const verifyPr1b = () => result("lab", VERIFY_PR1B);

test("la migración de PR1b se puede reaplicar y verify_pr1b_migration.sql supera todos los bloques", () => {
  psqlFile("lab", PR1B);
  psqlFile("lab", PR1B);
  assert.equal(verifyPr1b(), "OK: verificación PR1b superada");
  assert.equal(verifyPr1a(), "OK: verificación PR1a superada", "PR1b no rompe PR1a");
});

test("el verificador de PR1b detecta vulnerabilidades reintroducidas", () => {
  psql("lab", "grant execute on function public.agent_reserve(text,integer,integer) to anon;");
  try {
    assert.match(verifyPr1b(), /FALLO: anon pudo reservar presupuesto/);
  } finally {
    psql("lab", "revoke execute on function public.agent_reserve(text,integer,integer) from anon;");
  }

  withFunctionMutation("public.agent_reserve(text,integer,integer)",
    "v_row.spent_eur + v_row.reserved_eur + v_estimate > v_budget",
    "v_row.spent_eur + v_row.reserved_eur + v_estimate > v_budget * 100", () =>
      assert.match(verifyPr1b(), /FALLO: reservó por encima del presupuesto/));

  withFunctionMutation("public.agent_track_event(jsonb)",
    "(p_event ->> v_field) !~ '^[a-z0-9_-]{1,40}$'",
    "false", () =>
      assert.match(verifyPr1b(), /FALLO: aceptó un email en un evento/));

  assert.equal(verifyPr1b(), "OK: verificación PR1b superada");
});

test("rollback de PR1b: retira las funciones, conserva los datos y se puede reaplicar", () => {
  psql("lab", "insert into private.agent_budget_months (month, spent_eur) values (date '2026-01-01', 1.5) on conflict do nothing;");
  try {
    psqlFile("lab", PR1B_ROLLBACK);
    assert.equal(psql("lab", "select count(*) from pg_proc where proname like 'agent\\_%' and pronamespace = 'public'::regnamespace"), "0");
    assert.equal(psql("lab", "select spent_eur from private.agent_budget_months where month = date '2026-01-01'"), "1.500000");
  } finally {
    psqlFile("lab", PR1B);
    psql("lab", "delete from private.agent_budget_months where month = date '2026-01-01';");
  }
  assert.equal(verifyPr1b(), "OK: verificación PR1b superada");
});
