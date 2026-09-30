-- PR2 (pasos 1–8): laboratorio privado del agente comercial.
--
-- 1. Configuración del agente ampliada (sin tocar el presupuesto público de
--    PR1b): modo público APAGADO, modo privado, modelos candidatos con precio
--    propio (USD por millón de tokens, incluida la entrada en caché), versión
--    de modelo que se pide a la API (api_model), región UE y límites de
--    entrada/salida. real_call_allowance: cupo de mensajes con proveedor REAL
--    (0 = ninguno, null = sin cupo); se descuenta atómicamente en cada reserva
--    y se concede expresamente para cada prueba. models.<m>.eu = true solo cuando OpenAI confirme la UE
--    para NUESTRA organización (los tres modelos son elegibles según su
--    documentación de 30/09/2026, pero la UE exige aprobar MAM o ZDR).
-- 2. Presupuesto de pruebas SEPARADO (5 € en total, no mensual) con reserva
--    previa y liquidación, serializado con un advisory lock propio. No consume
--    el presupuesto público de 25 €/mes.
-- 3. Conversaciones de prueba (solo modo privado) conservadas 30 días para
--    evaluación, con valoración humana; borrado automático al caducar.
-- 4. API: la Edge Function (service role) reserva, liquida y registra; el CRM
--    administrador consulta, valora y ve el resumen por modelo.
--
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20261001_agent_private_lab_down.sql
begin;

-- ---------------------------------------------------------------------------
-- 1. Configuración (las claves existentes prevalecen: no se pisa nada)
-- ---------------------------------------------------------------------------
update private.settings
   set value = '{
      "public_enabled": false,
      "preview_enabled": true,
      "preview_budget_eur": 5,
      "max_calls_per_minute": 20,
      "max_input_chars": 1000,
      "max_output_tokens": 400,
      "max_history_turns": 8,
      "transcript_days": 30,
      "region": "eu",
      "usd_eur": 0.90,
      "default_model": null,
      "real_call_allowance": 0,
      "models": {
        "gpt-5.4-mini": {"in": 0.75, "cached_in": 0.075, "out": 4.50, "eu": null, "api_model": "gpt-5.4-mini-2026-03-17"},
        "gpt-5.6-luna": {"in": 0.20, "cached_in": 0.02, "out": 1.20, "eu": null, "api_model": "gpt-5.6-luna"},
        "gpt-6-luna": {"in": 0.10, "cached_in": 0.01, "out": 0.50, "eu": null, "api_model": "gpt-6-luna"}
      }
    }'::jsonb || value,
       description = 'Agente comercial. public_enabled=false hasta validación jurídica. Presupuesto público mensual (monthly_budget_eur) y de pruebas total (preview_budget_eur) separados. Precios de models en USD/Mtok (30/09/2026). enabled=false o presupuesto agotado → respuestas fijas sin IA.',
       updated_at = now()
 where key = 'agent';

-- ---------------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------------
create table if not exists private.agent_preview_ledger (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  model text not null,
  reserved_eur numeric(12, 6) not null check (reserved_eur >= 0),
  spent_eur numeric(12, 6) not null default 0 check (spent_eur >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released', 'expired')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists agent_preview_ledger_open_idx on private.agent_preview_ledger (created_at) where status = 'reserved';

create table if not exists private.agent_test_transcripts (
  id bigserial primary key,
  conversation_id text not null,
  turn integer not null check (turn >= 0),
  model text not null,
  case_id text,
  user_text text not null,            -- ya redactado (sin emails, teléfonos, DNI, IBAN)
  reply text not null,
  actions jsonb not null default '[]'::jsonb,
  intent text,
  input_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_eur numeric(12, 6) not null default 0,
  latency_ms integer,
  fallback_reason text,
  filters jsonb not null default '{}'::jsonb,
  rating jsonb,
  comment text,
  tester_sub text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index if not exists agent_test_transcripts_conv_idx on private.agent_test_transcripts (conversation_id, turn);
create index if not exists agent_test_transcripts_expires_idx on private.agent_test_transcripts (expires_at);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Utilidades internas
-- ---------------------------------------------------------------------------
-- Coste en euros de una llamada con los precios del modelo (USD/Mtok).
create or replace function private.agent_model_cost(
  p_model text, p_input integer, p_cached integer, p_output integer, p_config jsonb
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_price jsonb := p_config -> 'models' -> p_model;
  v_input integer := greatest(coalesce(p_input, 0), 0);
  v_cached integer := least(greatest(coalesce(p_cached, 0), 0), greatest(coalesce(p_input, 0), 0));
begin
  if v_price is null then
    raise exception 'agent_model_invalid';
  end if;
  return round(
    ((v_input - v_cached) * (v_price ->> 'in')::numeric
     + v_cached * (v_price ->> 'cached_in')::numeric
     + greatest(coalesce(p_output, 0), 0) * (v_price ->> 'out')::numeric)
    / 1000000 * coalesce((p_config ->> 'usd_eur')::numeric, 1),
    6);
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. API de la Edge Function (solo service role)
-- ---------------------------------------------------------------------------
-- Configuración que necesita la Edge Function (sin presupuestos ni secretos).
create or replace function public.agent_runtime_config()
returns jsonb
language sql
stable
security definer
set search_path = private, pg_temp
as $$
  select jsonb_build_object(
    'enabled', coalesce((v ->> 'enabled')::boolean, false),
    'public_enabled', coalesce((v ->> 'public_enabled')::boolean, false),
    'preview_enabled', coalesce((v ->> 'preview_enabled')::boolean, false),
    'region', v ->> 'region',
    'models', v -> 'models',
    'default_model', v -> 'default_model',
    'max_input_chars', coalesce((v ->> 'max_input_chars')::integer, 1000),
    'max_output_tokens', coalesce((v ->> 'max_output_tokens')::integer, 400),
    'max_history_turns', coalesce((v ->> 'max_history_turns')::integer, 8))
  from (select private.agent_config() as v) c
$$;

-- Reserva el coste máximo de una llamada de prueba. status:
--   reserved | disabled | model_invalid | rate_limited | budget_exhausted | allowance_exhausted
-- p_provider = 'openai' consume una unidad de real_call_allowance (si no es null).
drop function if exists public.agent_preview_reserve(text, text, integer, integer);
create or replace function public.agent_preview_reserve(
  p_conversation_id text,
  p_model text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_provider text default 'simulated'
)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_config jsonb;
  v_conversation text := private.agent_valid_session(p_conversation_id);
  v_estimate numeric;
  v_committed numeric;
  v_id uuid;
begin
  if coalesce(p_max_input_tokens, -1) < 0 or coalesce(p_max_output_tokens, -1) < 0
     or p_max_input_tokens > 200000 or p_max_output_tokens > 32000 then
    raise exception 'agent_tokens_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_preview_budget'));
  v_config := private.agent_config();
  if v_config is null or not coalesce((v_config ->> 'preview_enabled')::boolean, false) then
    return jsonb_build_object('status', 'disabled');
  end if;
  if v_config -> 'models' -> p_model is null then
    return jsonb_build_object('status', 'model_invalid');
  end if;

  update private.agent_preview_ledger
     set status = 'expired', closed_at = now()
   where status = 'reserved'
     and created_at < now() - make_interval(mins => coalesce((v_config ->> 'reservation_ttl_minutes')::integer, 10));

  if not private.rate_hit('agent:preview:minute', interval '1 minute', (v_config ->> 'max_calls_per_minute')::integer) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- Cupo de llamadas REALES: sin cupo no se contacta con el proveedor.
  if p_provider = 'openai' and jsonb_typeof(v_config -> 'real_call_allowance') = 'number' then
    if (v_config ->> 'real_call_allowance')::integer <= 0 then
      return jsonb_build_object('status', 'allowance_exhausted');
    end if;
  end if;

  v_estimate := private.agent_model_cost(p_model, p_max_input_tokens, 0, p_max_output_tokens, v_config);
  select coalesce(sum(case when status = 'settled' then spent_eur when status = 'reserved' then reserved_eur else 0 end), 0)
    into v_committed from private.agent_preview_ledger;
  if v_committed + v_estimate > coalesce((v_config ->> 'preview_budget_eur')::numeric, 0) then
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  if p_provider = 'openai' and jsonb_typeof(v_config -> 'real_call_allowance') = 'number' then
    update private.settings
       set value = jsonb_set(value, '{real_call_allowance}', to_jsonb((v_config ->> 'real_call_allowance')::integer - 1)),
           updated_at = now()
     where key = 'agent';
  end if;

  insert into private.agent_preview_ledger (conversation_id, model, reserved_eur)
  values (v_conversation, p_model, v_estimate)
  returning id into v_id;
  return jsonb_build_object('status', 'reserved', 'reservation_id', v_id, 'max_cost_eur', v_estimate);
end;
$$;

-- Liquida con los tokens reales (idempotente).
create or replace function public.agent_preview_settle(
  p_reservation_id uuid,
  p_input_tokens integer,
  p_cached_tokens integer,
  p_output_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_row private.agent_preview_ledger;
  v_cost numeric;
begin
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_cached_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0
     or p_input_tokens > 200000 or p_output_tokens > 32000 or p_cached_tokens > p_input_tokens then
    raise exception 'agent_tokens_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_preview_budget'));
  select * into v_row from private.agent_preview_ledger where id = p_reservation_id for update;
  if v_row.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.status <> 'reserved' then
    return jsonb_build_object('status', 'already_closed');
  end if;
  v_cost := private.agent_model_cost(v_row.model, p_input_tokens, p_cached_tokens, p_output_tokens, private.agent_config());
  update private.agent_preview_ledger
     set status = 'settled', spent_eur = v_cost, input_tokens = p_input_tokens,
         cached_tokens = p_cached_tokens, output_tokens = p_output_tokens, closed_at = now()
   where id = p_reservation_id;
  return jsonb_build_object('status', 'settled', 'cost_eur', v_cost);
end;
$$;

-- Libera una reserva si la llamada falla (idempotente).
create or replace function public.agent_preview_release(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_preview_budget'));
  update private.agent_preview_ledger
     set status = 'released', closed_at = now()
   where id = p_reservation_id and status = 'reserved';
  return jsonb_build_object('status', case when found then 'released' else 'already_closed' end);
end;
$$;

-- Guarda un turno de una conversación de prueba y purga lo caducado.
create or replace function public.agent_preview_log_turn(p_turn jsonb)
returns bigint
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_config jsonb := private.agent_config();
  v_id bigint;
begin
  if coalesce(p_turn ->> 'user_text', '') ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' then
    raise exception 'agent_transcript_unredacted';
  end if;
  insert into private.agent_test_transcripts (
    conversation_id, turn, model, case_id, user_text, reply, actions, intent,
    input_tokens, cached_tokens, output_tokens, cost_eur, latency_ms,
    fallback_reason, filters, tester_sub, expires_at)
  values (
    private.agent_valid_session(p_turn ->> 'conversation_id'),
    (p_turn ->> 'turn')::integer,
    left(p_turn ->> 'model', 40),
    left(nullif(p_turn ->> 'case_id', ''), 20),
    left(p_turn ->> 'user_text', 2000),
    left(p_turn ->> 'reply', 4000),
    coalesce(p_turn -> 'actions', '[]'::jsonb),
    left(nullif(p_turn ->> 'intent', ''), 40),
    coalesce((p_turn ->> 'input_tokens')::integer, 0),
    coalesce((p_turn ->> 'cached_tokens')::integer, 0),
    coalesce((p_turn ->> 'output_tokens')::integer, 0),
    coalesce((p_turn ->> 'cost_eur')::numeric, 0),
    (p_turn ->> 'latency_ms')::integer,
    left(nullif(p_turn ->> 'fallback_reason', ''), 40),
    coalesce(p_turn -> 'filters', '{}'::jsonb),
    left(nullif(p_turn ->> 'tester_sub', ''), 64),
    now() + make_interval(days => coalesce((v_config ->> 'transcript_days')::integer, 30)))
  returning id into v_id;

  delete from private.agent_test_transcripts where expires_at < now();
  return v_id;
end;
$$;

create or replace function public.agent_purge_test_transcripts()
returns integer
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_count integer;
begin
  delete from private.agent_test_transcripts where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. API del CRM (administrador)
-- ---------------------------------------------------------------------------
-- La Edge Function la usa para comprobar el JWT del probador: PostgREST valida
-- la firma y aquí se comprueba el rol de administrador.
create or replace function public.agent_lab_whoami()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('admin', public.is_crm_admin(), 'sub', auth.jwt() ->> 'sub')
$$;

create or replace function public.agent_lab_turns(p_conversation_id text default null, p_limit integer default 200)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = private, public, pg_temp
as $$
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return query
    select to_jsonb(t) - 'tester_sub'
      from private.agent_test_transcripts t
     where t.expires_at >= now()
       and (p_conversation_id is null or t.conversation_id = p_conversation_id)
     order by t.created_at desc, t.turn desc
     limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

create or replace function public.agent_lab_rate(p_id bigint, p_rating jsonb, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_key text;
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rating) <> 'object' then
    raise exception 'rating_invalid';
  end if;
  for v_key in select jsonb_object_keys(p_rating) loop
    if v_key not in ('precision', 'utilidad', 'limites', 'tono', 'conversion')
       or jsonb_typeof(p_rating -> v_key) <> 'number'
       or (p_rating ->> v_key)::numeric not in (1, 2, 3, 4, 5) then
      raise exception 'rating_invalid';
    end if;
  end loop;
  if length(coalesce(p_comment, '')) > 500 then
    raise exception 'comment_invalid';
  end if;
  update private.agent_test_transcripts
     set rating = p_rating, comment = nullif(trim(coalesce(p_comment, '')), '')
   where id = p_id and expires_at >= now();
  return jsonb_build_object('status', case when found then 'rated' else 'not_found' end);
end;
$$;

-- Resumen por modelo + presupuesto de pruebas.
create or replace function public.agent_lab_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_config jsonb := private.agent_config();
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'budget', jsonb_build_object(
      'limit_eur', coalesce((v_config ->> 'preview_budget_eur')::numeric, 0),
      'spent_eur', (select coalesce(sum(spent_eur), 0) from private.agent_preview_ledger where status = 'settled'),
      'reserved_eur', (select coalesce(sum(reserved_eur), 0) from private.agent_preview_ledger where status = 'reserved')),
    'public_enabled', coalesce((v_config ->> 'public_enabled')::boolean, false),
    'region', v_config ->> 'region',
    'models', (select coalesce(jsonb_agg(m order by m ->> 'model'), '[]'::jsonb) from (
      select jsonb_build_object(
        'model', model,
        'turns', count(*),
        'conversations', count(distinct conversation_id),
        'cost_eur', round(sum(cost_eur), 6),
        'cost_per_conversation_eur', round(sum(cost_eur) / nullif(count(distinct conversation_id), 0), 6),
        'latency_p50_ms', percentile_cont(0.5) within group (order by latency_ms),
        'latency_p95_ms', percentile_cont(0.95) within group (order by latency_ms),
        'fallback_rate', round(avg(case when fallback_reason is null then 0 else 1 end), 4),
        'rated', count(rating),
        'avg_rating', (select jsonb_object_agg(k, round(avg_v, 2)) from (
            select key as k, avg(value::numeric) as avg_v
              from private.agent_test_transcripts t2, jsonb_each_text(t2.rating)
             where t2.model = t.model and t2.expires_at >= now() and t2.rating is not null
             group by key) r)
      ) as m
        from private.agent_test_transcripts t
       where expires_at >= now()
       group by model) s));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Permisos
-- ---------------------------------------------------------------------------
revoke all on function public.agent_runtime_config() from public, anon, authenticated;
revoke all on function public.agent_preview_reserve(text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.agent_preview_settle(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_preview_release(uuid) from public, anon, authenticated;
revoke all on function public.agent_preview_log_turn(jsonb) from public, anon, authenticated;
revoke all on function public.agent_purge_test_transcripts() from public, anon, authenticated;
revoke all on function public.agent_lab_whoami() from public, anon, authenticated;
revoke all on function public.agent_lab_turns(text, integer) from public, anon, authenticated;
revoke all on function public.agent_lab_rate(bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.agent_lab_summary() from public, anon, authenticated;

grant execute on function public.agent_runtime_config() to service_role;
grant execute on function public.agent_preview_reserve(text, text, integer, integer, text) to service_role;
grant execute on function public.agent_preview_settle(uuid, integer, integer, integer) to service_role;
grant execute on function public.agent_preview_release(uuid) to service_role;
grant execute on function public.agent_preview_log_turn(jsonb) to service_role;
grant execute on function public.agent_purge_test_transcripts() to service_role;
-- Las del CRM comprueban is_crm_admin() dentro.
grant execute on function public.agent_lab_whoami() to authenticated;
grant execute on function public.agent_lab_turns(text, integer) to authenticated;
grant execute on function public.agent_lab_rate(bigint, jsonb, text) to authenticated;
grant execute on function public.agent_lab_summary() to authenticated;

commit;
