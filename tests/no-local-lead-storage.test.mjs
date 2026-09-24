// Comprobación estática (PR0): las páginas públicas no copian leads al
// almacenamiento del navegador del visitante.
// Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const publicScripts = ["script.js", "diagnostico/diagnostico.js", "supabase-bridge.js"];

test("los scripts públicos no escriben el estado del CRM ni colas de leads", () => {
  for (const path of publicScripts) {
    const source = read(path);
    assert.doesNotMatch(source, /legalprevent-crm-v1/, `${path} no debe usar el almacenamiento del CRM`);
    assert.doesNotMatch(source, /lp_last_crm_lead_id/, path);
    assert.doesNotMatch(source, /localStorage\.setItem\((?!consentKey)/, `${path} solo puede guardar la preferencia de cookies`);
  }
});

test("los scripts públicos no vuelcan datos de leads en la consola", () => {
  for (const path of publicScripts) {
    assert.doesNotMatch(read(path), /console\.info\(/, path);
  }
});

test("el bridge ya no envía el lead completo a la función de avisos", () => {
  const source = read("supabase-bridge.js");
  assert.match(source, /body: JSON\.stringify\(\{ leadId, kind \}\)/);
});

test("la función de avisos no envía emails a la dirección del visitante", () => {
  const source = read("supabase/functions/send-lead-email/index.ts");
  assert.doesNotMatch(source, /to:\s*\[lead\.email\]/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin":\s*"\*"/);
});
