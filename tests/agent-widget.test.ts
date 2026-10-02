// Widget Escudito (PR2f): lógica pura (activación, lista blanca de acciones y
// enlaces, vista previa) y comprobaciones estáticas de privacidad y de
// publicación. El comportamiento en el navegador (foco, teclado, ARIA, móvil)
// se revisa en el laboratorio con la web servida.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ACTIONS, resolveAction } from "../supabase/functions/sales-agent/actions.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SOURCE = read("agent-widget.js");

// Se evalúa sin `document`: solo expone la API, no arranca.
function loadWidget() {
  const context: Record<string, any> = { URL };
  vm.runInNewContext(SOURCE, context);
  return context.LegalPreventAgentWidget;
}
const W = loadWidget();

test("cerrado para visitantes: PUBLIC_LAUNCHER=false y solo se activa con #agente-preview", () => {
  assert.equal(W.PUBLIC_LAUNCHER, false);
  assert.match(SOURCE, /const PUBLIC_LAUNCHER = false;/);
  for (const pathname of ["/", "/index.html", "/partner/", "/partner/index.html"]) {
    assert.equal(W.shouldActivate({ pathname, hash: "" }), false, `${pathname} sin vista previa`);
    assert.equal(W.shouldActivate({ pathname, hash: "#precios" }), false);
    assert.equal(W.shouldActivate({ pathname, hash: "#agente-preview" }), true, `${pathname} con vista previa`);
  }
});

test("nunca en /diagnostico/ ni en otras páginas, aunque se lance", () => {
  for (const pathname of ["/diagnostico/", "/diagnostico/index.html", "/gracias/", "/politica-privacidad/", "/crm/"]) {
    assert.equal(W.shouldActivate({ pathname, hash: "#agente-preview" }), false, pathname);
    assert.equal(W.shouldActivate({ pathname, hash: "", launcher: true }), false, pathname);
  }
  assert.equal(W.shouldActivate({ pathname: "/", hash: "", launcher: true }), true, "en el lanzamiento, portada");
  assert.equal(W.pagePath("/partner/index.html"), "/partner/");
  assert.equal(W.pagePath("/diagnostico/"), null);
});

test("enlaces: solo LegalPrevent y contratación (https, sin trucos de dominio)", () => {
  for (const url of [
    "https://legalprevent.com/#precios", "https://legalprevent.com/diagnostico/", "https://www.legalprevent.com/partner/",
    "https://legalprevent.legal/comprar?plan=pyme",
  ]) assert.equal(W.isAllowedUrl(url), true, url);
  for (const url of [
    "http://legalprevent.com/", "https://legalprevent.com.evil.example/", "https://evil.example/?u=https://legalprevent.com/",
    "javascript:alert(1)", "data:text/html,hola", "//legalprevent.com/", "https://user@legalprevent.com/",
    "https://legalprevent.com:8443/", "https://legalprevent.legal/otra", "https://legalprevent.legal/comprar?plan=pyme&x=1",
    "https://legalprevent.legal/comprar?plan=pyme#x", "https://sub.legalprevent.com/", "", null,
  ]) assert.equal(W.isAllowedUrl(url), false, String(url));
});

test("acciones: el widget acepta exactamente la lista cerrada del servidor", () => {
  for (const id of ACTIONS) {
    const view = W.actionView(resolveAction(id));
    assert.ok(view, `${id} se pinta`);
    if (id.startsWith("link:")) assert.equal(view.contact, false);
    else assert.deepEqual([view.href, view.contact], ["/#contacto", true], `${id} lleva al formulario existente`);
  }
  // Cualquier otra cosa se descarta, aunque venga del servidor.
  for (const action of [
    { id: "link:externo", label: "x", url: "https://legalprevent.com/" },
    { id: "link:precios", label: "Ver precios", url: "https://evil.example/" },
    { id: "link:precios", label: "", url: "https://legalprevent.com/#precios" },
    { id: "form:otro", label: "x" }, { id: "exec", label: "x" }, null, "link:precios",
  ]) assert.equal(W.actionView(action), null, JSON.stringify(action));
  assert.equal(W.actionView({ id: "handoff", label: "x".repeat(200) }).label.length, 60);
});

test("vista previa: solo LEE la sesión del CRM; nunca escribe en el almacenamiento", () => {
  const writes: string[] = [];
  const storage = (value: string | null) => ({
    getItem: (key: string) => (key === "lp_supabase_session" ? value : null),
    setItem: (key: string) => writes.push(key),
    removeItem: (key: string) => writes.push(key),
  });
  assert.equal(W.previewToken(storage(JSON.stringify({ access_token: "jwt-admin" }))), "jwt-admin");
  assert.equal(W.previewToken(storage(null)), null);
  assert.equal(W.previewToken(storage("{no-json")), null);
  assert.equal(W.previewToken({ getItem: () => { throw new Error("bloqueado"); } }), null);
  assert.deepEqual(writes, []);
});

test("privacidad: sin localStorage, cookies, IndexedDB, escrituras de sessionStorage ni seguimiento", () => {
  const code = SOURCE.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /localStorage|indexedDB|document\.cookie|sendBeacon|navigator\.(userAgent|platform)|fingerprint/i);
  assert.doesNotMatch(code, /sessionStorage\.(setItem|removeItem|clear)|sessionStorage\[/);
  assert.equal((code.match(/sessionStorage/g) || []).length, 1, "un único acceso, de lectura, en la vista previa");
  assert.match(code, /preview \? previewToken\(win\.sessionStorage\) : null/);
  // Una sola llamada de red: la función del asistente.
  assert.equal((code.match(/\bfetch\(/g) || []).length, 1);
  assert.match(code, /\/functions\/v1\/sales-agent`/);
});

test("el texto del servidor nunca se inserta como HTML", () => {
  const assignments = [...SOURCE.matchAll(/\.innerHTML = ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(assignments.length > 0);
  for (const rhs of assignments) assert.match(rhs, /^(mascot\(|'<svg )/, `innerHTML solo con SVG fijo: ${rhs}`);
  assert.match(SOURCE, /el\("p", \{ class: `lpa-msg lpa-bot[^`]*`, text \}\)/, "las respuestas van como texto");
});

test("textos aprobados: aviso, pie y las tres preguntas", () => {
  assert.equal(W.TEXT.notice, "Soy un asistente de IA. Para proteger tu privacidad, no incluyas datos personales como nombre, email, teléfono o DNI. Puedo ofrecerte información general sobre LegalPrevent, pero no asesoramiento jurídico individualizado.");
  assert.equal(W.TEXT.footer, "Respuestas generadas por IA a partir de la información de LegalPrevent. Para cuestiones específicas, puedes hablar con nuestro equipo.");
  assert.deepEqual([...W.TEXT.questions], ["¿Cuánto cuesta LegalPrevent?", "¿Qué incluye el diagnóstico gratuito?", "Soy gestoría o asesoría, ¿qué me ofrecéis?"]);
  assert.match(SOURCE, /href: "\/politica-privacidad\/"/);
});

test("mascota: SVG decorativo y sin recursos externos", () => {
  for (const size of [24, 56]) {
    const svg = W.mascot(size);
    assert.match(svg, new RegExp(`width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"`));
    assert.doesNotMatch(svg, /href|url\(|<image|<script/);
  }
  assert.match(W.mascot(24, "thinking"), /is-thinking/);
});

test("páginas: el widget solo se carga en la portada y en /partner/", () => {
  const tag = /<script src="\.{1,2}\/agent-widget\.js\?v=\d{8}-\d" defer><\/script>/g;
  assert.equal((read("index.html").match(tag) || []).length, 1);
  assert.equal((read("partner/index.html").match(tag) || []).length, 1);
  for (const page of ["diagnostico/index.html", "gracias/index.html", "politica-privacidad/index.html", "aviso-legal/index.html", "crm/index.html"]) {
    assert.doesNotMatch(read(page), /agent-widget/, page);
  }
});

test("Pages: la allowlist publica solo el JS y el CSS del widget, nada interno", () => {
  const list = read(".github/pages-allowlist.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(list.includes("agent-widget.js") && list.includes("agent-widget.css"));
  for (const path of list) {
    assert.doesNotMatch(path, /^(tests|supabase|tools|\.github)\/|\.(md|sql|ts|mjs|sh|csv)$/, `no se publica ${path}`);
  }
});

test("CSS: todo bajo #lp-agent/.lpa-, movimiento reducido y botón de cerrar accesible", () => {
  const css = read("agent-widget.css");
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2].trim());
  for (const selector of selectors) {
    for (const part of selector.split(",").map((s) => s.trim())) {
      if (/^(from|to|\d+%)/.test(part)) continue; // fotogramas
      assert.match(part, /(#lp-agent|\.lpa-|^html\.lpa-lock)/, `selector fuera del widget: ${part}`);
    }
  }
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const target of [".lpa-panel", ".lpa-launcher", ".lpa-dots i", ".lpa-mascot .lpa-eye"]) assert.ok(reduced.includes(target), target);
  assert.match(reduced, /animation: none !important;\s*transition: none !important;/);
  assert.match(SOURCE, /class: "lpa-close", "aria-label": TEXT\.close/);
  assert.match(SOURCE, /role: "dialog", "aria-labelledby": "lpa-title"/);
  assert.match(SOURCE, /role: "log", "aria-live": "polite"/);
});
