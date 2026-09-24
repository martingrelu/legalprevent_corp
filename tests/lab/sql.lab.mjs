// Migración, verificación SQL, mutaciones de seguridad y permisos efectivos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATION, ROOT, VERIFY, psql, psqlFile } from "./helpers.mjs";

const verify = () => {
  const out = psqlFile("lab", VERIFY, { allowError: true });
  return (out.match(/(FALLO: [^\n]*|OK: [^\n]*)/) || [out.slice(0, 200)])[0];
};

// Sustituye temporalmente el cuerpo de una función y lo restaura al terminar.
function withMutation(signature, from, to, fn) {
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

test("la migración se puede aplicar de nuevo sin errores (idempotente)", () => {
  psqlFile("lab", MIGRATION);
  psqlFile("lab", MIGRATION);
});

test("verify_pr0_migration.sql supera los 10 bloques", () => {
  assert.equal(verify(), "OK: verificación PR0 superada");
});

test("el verificador detecta vulnerabilidades reintroducidas", () => {
  psql("lab", `grant insert on public.leads to anon;
    create policy lab_mut on public.leads for insert to anon with check (true);`);
  try {
    assert.match(verify(), /FALLO: anon pudo insertar directamente en leads/);
  } finally {
    psql("lab", "drop policy lab_mut on public.leads; revoke insert on public.leads from anon;");
  }

  psql("lab", "grant execute on function public.claim_lead_notification(uuid,text,integer) to anon;");
  try {
    assert.match(verify(), /FALLO: anon pudo ejecutar claim_lead_notification/);
  } finally {
    psql("lab", "revoke execute on function public.claim_lead_notification(uuid,text,integer) from anon;");
  }

  withMutation("public.claim_lead_notification(uuid,text,integer)", "and notified_at is null", "", () =>
    assert.match(verify(), /FALLO: segunda reclamación del mismo lead no rechazada/));

  withMutation("public.assert_public_submission(jsonb)", "raise exception 'privacy_required'", "null", () =>
    assert.match(verify(), /FALLO: submit_lead aceptó/));

  assert.equal(verify(), "OK: verificación PR0 superada");
});

test("permisos efectivos de anon tras la migración", () => {
  const tables = psql("lab", `select string_agg(format('%s:%s', t, has_table_privilege('anon', 'public.'||t, p)), ',' order by t, p)
    from unnest(array['leads','diagnostics']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;`);
  assert.doesNotMatch(tables, /:t/, `anon conserva privilegios: ${tables}`);

  const fns = Object.fromEntries(
    psql("lab", `select proname, has_function_privilege('anon', oid, 'EXECUTE') from pg_proc
      where pronamespace = 'public'::regnamespace and proname in
      ('submit_lead','submit_diagnostic','request_lead_demo','claim_lead_notification','release_lead_notification','assert_public_submission');`)
      .split("\n").map((line) => line.split("|")),
  );
  assert.deepEqual(fns, {
    submit_lead: "t",
    submit_diagnostic: "t",
    request_lead_demo: "t",
    claim_lead_notification: "f",
    release_lead_notification: "f",
    assert_public_submission: "f",
  });
});

test("pr0-snapshot.sql (captura previa) se ejecuta en la base publicada sin modificar nada", () => {
  const before = psql("lab_old", "select md5(string_agg(t::text, ',')) from (select * from public.leads order by id) t");
  const out = psqlFile("lab_old", `${ROOT}supabase/deploy/pr0-snapshot.sql`);
  assert.match(out, /columna notified_at existe\|false/);
  assert.match(out, /postgres miembro de anon\|true/);
  assert.match(out, /def submit_lead\|CREATE OR REPLACE FUNCTION public.submit_lead/);
  assert.equal(psql("lab_old", "select md5(string_agg(t::text, ',')) from (select * from public.leads order by id) t"), before);
});
