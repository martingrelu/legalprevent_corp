// Utilidades compartidas por las pruebas del laboratorio.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ANON, SERVICE } from "./jwt.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const GATEWAY = `http://127.0.0.1:${process.env.LAB_GATEWAY_PORT || 54321}`;
export const REST = `http://127.0.0.1:${process.env.LAB_REST_PORT || 53000}`;
const PG = process.env.LAB_PG_CONTAINER || "lp-lab-pg";

export const MIGRATION = `${ROOT}supabase/migrations/20260924_lead_notification_claim.sql`;
export const ROLLBACK = `${ROOT}supabase/rollback/20260924_lead_notification_claim_down.sql`;
export const VERIFY = `${ROOT}tests/sql/verify_pr0_migration.sql`;

// psql dentro del contenedor. Devuelve stdout; con `allowError` no lanza y
// devuelve stdout + stderr (donde psql escribe los NOTICE y los errores).
export function psql(db, sql, { allowError = false } = {}) {
  const result = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tAq"], {
    input: sql,
    encoding: "utf8",
  });
  if (allowError) return `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
// Variante asíncrona: un proceso psql independiente (una sesión propia).
export function psqlAsync(db, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tAq"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    child.stdin.end(sql);
  });
}
export const psqlFile = (db, path, options) => psql(db, readFileSync(path, "utf8"), options);

export const VERIFY_PR1A = `${ROOT}tests/sql/verify_pr1a_migration.sql`;
export const VERIFY_PR1B = `${ROOT}tests/sql/verify_pr1b_migration.sql`;
export const VERIFY_PR1C = `${ROOT}tests/sql/verify_pr1c_migration.sql`;
export const VERIFY_PR1D = `${ROOT}tests/sql/verify_pr1d_migration.sql`;

// Límites de altas públicas (tabla private.settings de la base migrada).
export const GENEROUS_LIMITS = { ip_per_hour: null, email_per_day: null, global_per_minute: null, global_per_hour: null };
export function setLimits(limits, { ipSource = "none" } = {}) {
  psql("lab", `update private.settings set value = '${JSON.stringify({ ...GENEROUS_LIMITS, ...limits })}'::jsonb where key = 'public_limits';
    update private.settings set value = to_jsonb('${ipSource}'::text) where key = 'client_ip_source';`);
}

// Deja la base migrada vacía y con límites holgados (cada prueba de límites
// fija los suyos). lab_old (producción actual) se vacía aparte si se usa.
export async function reset(db = "lab") {
  psql(db, "truncate public.leads, public.diagnostics cascade;");
  if (db === "lab") {
    psql("lab", "truncate private.rate_counters;");
    setLimits({});
  }
  await fetch(`${GATEWAY}/__lab/reset`);
  await mode({ fn: "new", db: "new", resend: "ok", cap: 20 });
}
export const mode = (params) => fetch(`${GATEWAY}/__lab/mode?${new URLSearchParams(params)}`).then((r) => r.json());
export const emails = () => fetch(`${GATEWAY}/__lab/emails`).then((r) => r.json());

export const rpc = (name, args, token = ANON) =>
  fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  }).then((r) => r.json());
export const service = (name, args) => rpc(name, args, SERVICE);

export const callFunction = (body, origin = "http://127.0.0.1:8766") =>
  fetch(`${GATEWAY}/functions/v1/smooth-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export const newLead = async (i = 0, extra = {}) =>
  (await rpc("submit_lead", { p_payload: { email: `lab${i}@example.com`, privacy_accepted: true, ...extra } })).id;

// Llamada directa a PostgREST como anon con cabeceras de red simuladas.
export const rpcWithHeaders = (name, args, headers = {}) =>
  fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, ...headers },
    body: JSON.stringify(args),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

export const tally = (values) => values.reduce((acc, v) => ((acc[v] = (acc[v] || 0) + 1), acc), {});

// Carga un supabase-bridge.js (nuevo o publicado) como en el navegador, contra
// el gateway, con un almacenamiento simulado y la cabecera Origin del sitio.
export function loadBridge(source, { origin = "http://127.0.0.1:8766", session = null } = {}) {
  const storage = () => {
    const data = new Map();
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), keys: () => [...data.keys()] };
  };
  const localStorage = storage();
  const sessionStorage = storage();
  if (session) sessionStorage.setItem("lp_supabase_session", JSON.stringify({ access_token: session }));
  const window = {
    LEGAL_PREVENT_SUPABASE: { url: GATEWAY, anonKey: ANON },
    location: { href: `${origin}/`, origin },
  };
  const context = vm.createContext({
    window,
    localStorage,
    sessionStorage,
    console: { warn() {}, info() {}, error() {}, log() {} },
    fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Origin: origin } }),
  });
  vm.runInContext(source, context);
  return { api: window.LegalPreventSupabase, localStorage };
}
