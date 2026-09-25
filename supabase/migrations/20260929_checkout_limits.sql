-- PR1e: límites del checkout público (Edge Function `super-api`).
--
-- Cualquiera puede pedir una sesión de pago (también sin navegador: CORS no
-- es autenticación), así que la función consulta checkout_allow() antes de
-- llamar a Stripe. Reutiliza los contadores atómicos de PR1a (private.rate_hit).
--
-- El límite global es un cortafuegos contra avalanchas (llenar
-- checkout_sessions o agotar el límite de la API de Stripe), no un control por
-- usuario: un atacante que lo supere de forma sostenida también bloquea a los
-- clientes legítimos mientras dure el ataque. Por eso solo hay ventana de un
-- minuto (el bloqueo termina un minuto después de que pare) y ninguna por
-- hora. El límite por visitante (IP) queda pendiente de verificar qué cabecera
-- es fiable (ver client_ip_source en PR1a). El email, si se envía, se cuenta
-- en hash con sal diaria, nunca en claro.
--
-- Solo la service role (la Edge Function) puede usarla.
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20260929_checkout_limits_down.sql
begin;

insert into private.settings (key, value, description) values
  ('checkout_limits', '{"global_per_minute": 30, "global_per_hour": null, "email_per_hour": 5}',
   'Sesiones de pago de la web (cortafuegos global, ver supabase/deploy/PR1e.md). null = sin límite; 0 = checkout cerrado.')
on conflict (key) do nothing;

create or replace function public.checkout_allow(p_email text)
returns boolean
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_limits jsonb;
  v_ok boolean := true;
begin
  select value into v_limits from private.settings where key = 'checkout_limits';
  v_ok := private.rate_hit('checkout:minute', interval '1 minute', (v_limits ->> 'global_per_minute')::integer) and v_ok;
  v_ok := private.rate_hit('checkout:hour', interval '1 hour', (v_limits ->> 'global_per_hour')::integer) and v_ok;
  if nullif(trim(coalesce(p_email, '')), '') is not null then
    v_ok := private.rate_hit('checkout:email:' || private.salted_hash(p_email), interval '1 hour',
                             (v_limits ->> 'email_per_hour')::integer) and v_ok;
  end if;
  return v_ok;
end;
$$;

revoke all on function public.checkout_allow(text) from public, anon, authenticated;
grant execute on function public.checkout_allow(text) to service_role;

commit;
