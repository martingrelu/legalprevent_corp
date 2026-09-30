// Saneamiento del diagnóstico de errores del proveedor (modo privado, PR2).
// Nunca claves, tokens, cabeceras Authorization, JWT, emails ni secretos; sin
// HTML ni caracteres de control; longitud acotada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../supabase/functions/sales-agent/index.ts";
import { openaiError, PROVIDER_MESSAGE_MAX, sanitizeProviderText } from "../supabase/functions/sales-agent/providers.ts";

const KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefGHIJ";
const SECRET = "secreto-de-prueba-de-al-menos-32-caracteres";

test("enmascara claves de OpenAI completas, parciales y enmascaradas", () => {
  for (const sample of [
    `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
    "Incorrect API key provided: sk-proj-****************************WXYZ.",
    "clave sk-abc123",
  ]) {
    const out = sanitizeProviderText(sample)!;
    assert.doesNotMatch(out, /sk-(?!\[oculto\])/, out);
    assert.ok(!out.includes(KEY.slice(8, 20)));
    assert.match(out, /sk-\[oculto\]/);
  }
});

test("enmascara Authorization, Bearer, JWT, identificadores y emails", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJhLWRlLXBydWViYQ";
  const out = sanitizeProviderText(
    `Authorization: Bearer ${KEY} | bearer abc.def | token ${jwt} | org-AbCdEf123456 proj_Q1w2E3r4T5y6 user-Zx9Yw8Vv7 | contacto soporte@openai.com | ${"A".repeat(40)}`,
  )!;
  for (const leak of [KEY, "abc.def", jwt.slice(0, 20), "AbCdEf123456", "Q1w2E3r4T5y6", "Zx9Yw8Vv7", "soporte@openai.com", "A".repeat(40)]) {
    assert.ok(!out.includes(leak), `se filtró ${leak}: ${out}`);
  }
  assert.match(out, /authorization: \[oculto\]/i);
  assert.match(out, /\[jwt oculto\]/);
  assert.match(out, /org-\[oculto\]/);
  assert.match(out, /\[email\]/);
});

test("quita HTML, scripts y caracteres de control; recorta la longitud", () => {
  const html = "<html><head><style>body{}</style><script>alert('x')</script></head><body><h1>401 Authorization Required</h1>\u0000\u0007<p>nginx</p></body></html>";
  const out = sanitizeProviderText(html)!;
  assert.doesNotMatch(out, /[<>]|alert|body\{|\u0000|\u0007/);
  assert.match(out, /401 Authorization Required nginx/);
  const long = sanitizeProviderText("x ".repeat(2000))!;
  assert.ok(long.length <= PROVIDER_MESSAGE_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(sanitizeProviderText("   "), null);
  assert.equal(sanitizeProviderText(undefined), null);
});

test("openaiError: JSON de OpenAI, texto plano y cabeceras de la respuesta", async () => {
  const json = await openaiError(new Response(JSON.stringify({
    error: { message: `Incorrect API key provided: ${KEY}.`, type: "invalid_request_error", code: "invalid_api_key", param: null },
  }), { status: 401, headers: { "content-type": "application/json; charset=utf-8", "x-request-id": "req_abc123" } }));
  assert.equal(json.status, 401);
  assert.equal(json.info.code, "invalid_api_key");
  assert.equal(json.info.type, "invalid_request_error");
  assert.equal(json.info.request_id, "req_abc123");
  assert.equal(json.info.content_type, "application/json");
  assert.match(json.info.message!, /^Incorrect API key provided: sk-\[oculto\]/);
  assert.ok(!JSON.stringify(json.info).includes(KEY.slice(8)));

  const plain = await openaiError(new Response("Unauthorized: project is not enabled for data residency in eu", { status: 401, headers: { "content-type": "text/plain" } }));
  assert.equal(plain.info.code, null);
  assert.equal(plain.info.message, "Unauthorized: project is not enabled for data residency in eu");

  const weird = await openaiError(new Response(JSON.stringify({ error: { code: "x".repeat(200), type: { nested: true }, message: 42 } }), {
    status: 400, headers: { "x-request-id": `bad id with spaces ${KEY}` },
  }));
  assert.equal(weird.info.code, null, "códigos anómalos se descartan");
  assert.equal(weird.info.type, null);
  assert.equal(weird.info.request_id, null);
  assert.equal(weird.info.message, "42");
});

test("de extremo a extremo: el diagnóstico saneado llega al panel privado y al registro, nunca la clave ni la cabecera", async () => {
  const env: Record<string, string> = {
    SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon",
    AGENT_STATE_SECRET: SECRET, AGENT_PROVIDER: "openai", OPENAI_API_KEY: KEY,
  };
  const logged: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes("openai.com")) {
      // El proveedor devuelve la cabecera Authorization reflejada (caso extremo).
      return new Response(`<h1>401</h1> Invalid Authorization: Bearer ${KEY} for ${u}`, { status: 401, headers: { "content-type": "text/html", "x-request-id": "req_9f8e7d" } });
    }
    const name = u.split("/rpc/")[1];
    if (name === "agent_runtime_config") return ok({ preview_enabled: true, region: "eu", models: { "gpt-6-luna": { in: 0.1, cached_in: 0.01, out: 0.5, eu: true, api_model: "gpt-6-luna" } }, max_input_chars: 1000, max_output_tokens: 400, max_history_turns: 8 });
    if (name === "agent_lab_whoami") return ok({ admin: true, sub: "t" });
    if (name === "agent_preview_reserve") return ok({ status: "reserved", reservation_id: "r" });
    if (name === "agent_preview_log_turn") logged.push(String(init.body));
    return ok({ status: "ok" });
  }) as typeof fetch;
  const response = await handleRequest(new Request("https://p.supabase.co/functions/v1/sales-agent", {
    method: "POST", headers: { Authorization: "Bearer jwt-admin", Origin: "https://legalprevent.com", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "¿Cuánto cuesta?", model: "gpt-6-luna" }),
  }), { env: (k) => env[k], fetch: fakeFetch });
  const text = await response.text();
  const body = JSON.parse(text);
  const pe = body.debug.filters.provider_error;
  assert.equal(pe.status, 401);
  assert.equal(pe.request_id, "req_9f8e7d");
  assert.equal(pe.content_type, "text/html");
  assert.match(pe.message, /401 Invalid authorization: \[oculto\]/i);
  for (const out of [text, ...logged]) {
    assert.ok(!out.includes(KEY), "la clave nunca aparece");
    assert.ok(!out.includes(KEY.slice(8, 30)), "ni un fragmento de la clave");
    assert.doesNotMatch(out, /Bearer sk-/);
  }
  assert.ok(pe.message.length <= PROVIDER_MESSAGE_MAX);
  assert.doesNotMatch(body.reply, /401|Authorization|oculto/, "el visitante solo ve el fallback comercial");
});
