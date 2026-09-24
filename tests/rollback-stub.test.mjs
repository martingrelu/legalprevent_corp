// El stub de emergencia de smooth-action nunca envía emails ni lee la base.
import { test } from "node:test";
import assert from "node:assert/strict";

let handler = null;
const calls = [];
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: () => undefined } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { calls.push(args); return new Response("{}"); };
await import("../supabase/rollback/smooth-action-stub.ts");
delete globalThis.Deno;

test("responde sin enviar nada, con CORS solo para el dominio oficial", async () => {
  const post = await handler(new Request("https://x/functions/v1/smooth-action", {
    method: "POST",
    headers: { Origin: "https://legalprevent.com" },
    body: JSON.stringify({ lead: { email: "victima@example.com" } }),
  }));
  assert.equal(post.status, 202);
  assert.deepEqual(await post.json(), { ok: true, notified: false });
  assert.equal(post.headers.get("Access-Control-Allow-Origin"), "https://legalprevent.com");

  const evil = await handler(new Request("https://x/functions/v1/smooth-action", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(calls.length, 0);
  globalThis.fetch = originalFetch;
});
