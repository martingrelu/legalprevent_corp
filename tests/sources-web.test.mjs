// Adaptador web de AEPD e INSST (seo-engine/sources/adapters/web.mjs), robots.txt y extracción de HTML. Sin red:
// usa páginas y robots.txt REALES (recortados) capturados en tests/fixtures/web/ y un fetch simulado.
// Garantía central: una URL que responde NO acredita nada. Una cita web nunca es `verified`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareWebWithLock, createWebClient, evaluateWeb, MAX_BYTES, parseRobots, robotsAllows, USER_AGENT, verifyWebCitation } from "../seo-engine/sources/adapters/web.mjs";
import { FINGERPRINT_CHARS, contentWindow, decodeEntities, extractHeadings, extractTitle, htmlToText } from "../seo-engine/sources/html.mjs";
import { lockProblems } from "../seo-engine/sources/schema.mjs";
import { normalizeText, sha256Bytes, sha256Hex } from "../seo-engine/sources/text.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/web/${name}`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../content/sources/registry.json", import.meta.url), "utf8"));
const entryFor = (id) => structuredClone(registry.sources.find((entry) => entry.id === id));
const NOW = new Date("2026-10-21T12:00:00Z");
const PDF = Buffer.from("%PDF-1.4\n% documento sintético de prueba\n%%EOF\n");

const insst = entryFor("insst-gt-simplificacion-documental"); // ficha HTML + PDF
const insstHtmlOnly = { ...insst, urls: { canonical: insst.urls.canonical } }; // sin PDF: la cita se busca en el HTML
const aepd = entryFor("aepd-guia-calidad-datos-ia"); // PDF + listado oficial con el título
const FICHA = fixture("insst-ficha-simplificacion.html");
const LISTADO = fixture("aepd-listado-guias.html");
const QUOTE = "mandatando al INSST a disponer de una guía, de carácter no vinculante, que facilite la elaboración de dicho documento";

// ---- Fetch simulado ------------------------------------------------------------------------------
const res = ({ status = 200, type = "text/html; charset=UTF-8", body = "", headers = {} } = {}) => ({
  status,
  headers: new Headers({ "content-type": type, ...headers }),
  arrayBuffer: async () => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); // exacto, como un fetch real (sin el pool de Buffer)
  },
});
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route(init);
    return route ?? res({ status: 404, body: "no existe" });
  };
  fn.calls = calls;
  return fn;
}
const hostRoutes = (extra = {}) => ({
  "https://www.insst.es/robots.txt": res({ type: "text/plain", body: fixture("robots-insst.txt") }),
  "https://www.aepd.es/robots.txt": res({ type: "text/plain", body: fixture("robots-aepd.txt") }),
  [insst.urls.canonical]: res({ body: FICHA }),
  [insst.urls.document]: res({ type: "application/pdf", body: PDF, headers: { "last-modified": "Thu, 19 Nov 2020 15:39:23 GMT" } }),
  [aepd.urls.canonical]: res({ type: "application/pdf", body: PDF, headers: { "last-modified": "Tue, 21 Jul 2026 06:54:38 GMT" } }),
  [aepd.urls.index]: res({ body: LISTADO }),
  ...extra,
});
const clientFor = (routes, options = {}) => {
  const fetchImpl = fakeFetch(routes);
  return { fetchImpl, client: createWebClient({ fetchImpl, delayMs: 0, sleep: async () => {}, ...options }) };
};
const cita = (patch = {}) => ({ id: "c1", source: "insst-gt-simplificacion-documental", type: "criterio", locator: { section: "Resumen" }, ...patch });
const verify = (entry, citation, routes = hostRoutes(), options = {}) => verifyWebCitation({ client: clientFor(routes, options).client, entry, citation, now: NOW });

// ---- robots.txt ------------------------------------------------------------------------------------
test("robots.txt real del INSST y de la AEPD: se respetan las rutas prohibidas y se permiten las de las guías", () => {
  const insstRules = parseRobots(fixture("robots-insst.txt"));
  assert.ok(insstRules.length >= 20);
  assert.equal(robotsAllows(insstRules, new URL(insst.urls.canonical).pathname), true);
  assert.equal(robotsAllows(insstRules, "/documentacion/catalogo-de-publicaciones?sort=asc"), false, "patrón con comodín");
  assert.equal(robotsAllows(insstRules, "/user/perfil"), false);
  const aepdRules = parseRobots(fixture("robots-aepd.txt"));
  assert.equal(robotsAllows(aepdRules, new URL(aepd.urls.canonical).pathname), true);
  assert.equal(robotsAllows(aepdRules, "/admin/config"), false);
  assert.equal(robotsAllows(aepdRules, "/documento/convenio-aepd-cgpj-prorroga.pdf"), false, "la AEPD prohíbe documentos concretos");
});

test("el análisis de robots.txt sigue el estándar: grupos, agente específico, comodines, $ y precedencia", () => {
  const text = "# comentario\nUser-agent: *\nDisallow: /privado/\nAllow: /privado/publico\nDisallow: /*.json$\n\nUser-agent: legalpreventsourcecheck\nDisallow: /solo-nosotros/\n";
  const rules = parseRobots(text);
  assert.deepEqual(rules.map((r) => r.pattern), ["/solo-nosotros/"], "el grupo del agente específico sustituye al general");
  const general = parseRobots(text.replace("legalpreventsourcecheck", "otrobot"));
  assert.equal(robotsAllows(general, "/privado/x"), false);
  assert.equal(robotsAllows(general, "/privado/publico"), true, "gana la regla más larga (Allow)");
  assert.equal(robotsAllows(general, "/datos.json"), false, "$ ancla el final");
  assert.equal(robotsAllows(general, "/datos.json.bak"), true);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/lo-que-sea"), true, "Disallow vacío = todo permitido");
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n"), "/a"), true, "a igualdad, Allow");
  assert.deepEqual(parseRobots(""), []);
});

// ---- HTML ------------------------------------------------------------------------------------------
test("htmlToText descarta scripts, estilos y menús, une las etiquetas en línea y decodifica entidades", () => {
  const html = "<html><head><title>Guía&nbsp;de &quot;prueba&quot; &amp; más</title><style>p{}</style></head><body><nav>MENÚ</nav><script>var x=1</script><p>El art. 2 del <a href='/x'>Reglamento</a>, establece que&#8230; caf&eacute; &#x41;</p><footer>PIE</footer></body></html>";
  assert.equal(extractTitle(html), 'Guía de "prueba" & más');
  const text = htmlToText(html);
  assert.match(text, /El art\. 2 del Reglamento, establece que\.\.\. café A/);
  assert.doesNotMatch(text, /MENÚ|PIE|var x/);
  assert.equal(decodeEntities("&noExiste; &#99999999999;"), "&noExiste; &#99999999999;", "lo desconocido se deja tal cual");
  assert.deepEqual(extractHeadings("<h1 class='a'>Uno <em>y</em> dos</h1><h1>Tres</h1>"), ["Uno y dos", "Tres"]);
});

test("htmlToText sobre la ficha real del INSST conserva el resumen y el título", () => {
  const text = htmlToText(FICHA);
  assert.deepEqual(extractHeadings(FICHA), ["Guía técnica para la Simplificación documental - Año 2012"]);
  assert.match(extractTitle(FICHA), /simplificación documental - INSST$/);
  assert.ok(text.includes("GT.123"));
  assert.ok(normalizeText(text).includes(normalizeText(QUOTE)));
});

// ---- Cliente HTTP ---------------------------------------------------------------------------------
test("el cliente se identifica, sigue las redirecciones a mano, lee robots.txt una vez por host y cachea", async () => {
  const { client, fetchImpl } = clientFor(hostRoutes());
  const first = await client.get(insst.urls.canonical, "INSST");
  assert.equal(first.ok, true);
  assert.deepEqual([first.kind, first.contentType, first.title !== null, first.headings.length], ["html", "text/html", true, 1]);
  await client.get(insst.urls.canonical, "INSST");
  await client.get(insst.urls.document, "INSST");
  const urls = fetchImpl.calls.map((call) => call.url);
  assert.equal(urls.filter((u) => u.endsWith("/robots.txt")).length, 1, "robots.txt una sola vez por host");
  assert.equal(urls.filter((u) => u === insst.urls.canonical).length, 1, "caché");
  assert.ok(fetchImpl.calls.every((call) => call.init.headers["User-Agent"] === USER_AGENT && call.init.redirect === "manual" && call.init.method === "GET"));
  assert.match(USER_AGENT, /legalprevent\.com/);
});

test("el ritmo se limita por host, no entre hosts", async () => {
  const waits = [];
  const { client } = clientFor(hostRoutes(), { delayMs: 500, sleep: async (ms) => waits.push(ms) });
  await client.get(aepd.urls.canonical, "AEPD");
  await client.get(aepd.urls.index, "AEPD");
  assert.ok(waits.length >= 2 && waits.every((ms) => ms > 0 && ms <= 500), "espera entre peticiones al mismo host");
  const before = waits.length;
  await client.get(insst.urls.canonical, "INSST"); // robots.txt (primera petición a este host: sin espera) + la página (espera una vez)
  assert.equal(waits.length, before + 1, "otro host no espera por el anterior: solo espera entre sus propias peticiones");
});

test("las redirecciones dentro del dominio oficial se siguen; las que salen de él, no", async () => {
  const from = "https://www.aepd.es/guias/antigua.pdf";
  const ok = await clientFor(hostRoutes({ [from]: res({ status: 301, headers: { location: "/guias/calidad-datos-inteligencia-artificial.pdf" } }) })).client.get(from, "AEPD");
  assert.deepEqual([ok.ok, ok.url], [true, aepd.urls.canonical]);
  for (const location of ["https://example.com/guia.pdf", "http://www.aepd.es/guia.pdf", "https://www.aepd.es.evil.com/guia.pdf", "https://usuario:clave@www.aepd.es/guia.pdf"]) {
    const bad = await clientFor(hostRoutes({ [from]: res({ status: 302, headers: { location } }) })).client.get(from, "AEPD");
    assert.deepEqual([bad.ok, bad.error], [false, "redireccion_no_oficial"], location);
  }
  const loop = await clientFor(hostRoutes({ [from]: res({ status: 302, headers: { location: from } }) })).client.get(from, "AEPD");
  assert.equal(loop.error, "too_many_redirects");
  const noLocation = await clientFor(hostRoutes({ [from]: res({ status: 302 }) })).client.get(from, "AEPD");
  assert.equal(noLocation.error, "unexpected_status");
  assert.equal((await clientFor(hostRoutes()).client.get("https://example.com/x", "AEPD")).error, "redireccion_no_oficial", "una URL no oficial no llega a la red");
});

test("cada fallo de acceso se clasifica y ninguno es un éxito", async () => {
  const url = aepd.urls.canonical;
  const cases = {
    not_found: res({ status: 404 }),
    not_found_410: res({ status: 410 }),
    blocked: res({ status: 403 }),
    blocked_429: res({ status: 429 }),
    server_error: res({ status: 503 }),
    server_error_500: res({ status: 500, body: fixture("aepd-bloqueado-500.html") }),
    unexpected_status: res({ status: 418 }),
    soft_block: res({ body: fixture("aepd-bloqueado-500.html") }),
    network: new Error("ECONNRESET"),
  };
  for (const [label, route] of Object.entries(cases)) {
    const result = await clientFor(hostRoutes({ [url]: route })).client.get(url, "AEPD");
    assert.equal(result.ok, false, label);
    assert.equal(result.error, label.replace(/_(410|429|500)$/, ""), label);
  }
  const hang = createWebClient({ delayMs: 0, timeoutMs: 20, sleep: async () => {}, fetchImpl: (u, { signal }) => (u.endsWith("/robots.txt") ? res({ type: "text/plain", body: "" }) : new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("agotado"), { name: "AbortError" }))))) });
  assert.equal((await hang.get(url, "AEPD")).error, "timeout");
});

test("la página real de acceso bloqueado de la AEPD se reconoce aunque responda 200", async () => {
  const blocked = await clientFor(hostRoutes({ [aepd.urls.index]: res({ body: fixture("aepd-bloqueado-500.html") }) })).client.get(aepd.urls.index, "AEPD");
  assert.deepEqual([blocked.ok, blocked.error], [false, "soft_block"]);
});

test("robots.txt: una ruta prohibida no se descarga; si no se puede leer, no se verifica; un 404 permite", async () => {
  const doc = "https://www.aepd.es/documento/convenio-aepd-cgpj-prorroga.pdf";
  const denied = clientFor(hostRoutes({ [doc]: res({ type: "application/pdf", body: PDF }) }));
  assert.deepEqual([(await denied.client.get(doc, "AEPD")).error, denied.fetchImpl.calls.some((c) => c.url === doc)], ["robots_disallowed", false]);
  const unavailable = await clientFor(hostRoutes({ "https://www.aepd.es/robots.txt": res({ status: 503 }) })).client.get(aepd.urls.canonical, "AEPD");
  assert.equal(unavailable.error, "robots_unavailable");
  const networkDown = await clientFor(hostRoutes({ "https://www.aepd.es/robots.txt": new Error("DNS") })).client.get(aepd.urls.canonical, "AEPD");
  assert.equal(networkDown.error, "robots_unavailable");
  const noRobots = await clientFor(hostRoutes({ "https://www.aepd.es/robots.txt": res({ status: 404 }) })).client.get(aepd.urls.canonical, "AEPD");
  assert.equal(noRobots.ok, true);
});

test("el tamaño se limita por cabecera y por cuerpo, y la codificación declarada se respeta", async () => {
  const url = insst.urls.canonical;
  const byHeader = await clientFor(hostRoutes({ [url]: res({ body: "x", headers: { "content-length": String(MAX_BYTES.html + 1) } }) })).client.get(url, "INSST");
  assert.equal(byHeader.error, "too_large");
  const byBody = await clientFor(hostRoutes({ [url]: res({ body: Buffer.alloc(MAX_BYTES.html + 1, 97) }) })).client.get(url, "INSST");
  assert.equal(byBody.error, "too_large");
  const latin1 = await clientFor(hostRoutes({ [url]: res({ type: "text/html; charset=iso-8859-1", body: Buffer.from("<title>Gu\xEDa</title><h1>T\xEDtulo</h1>", "latin1") }) })).client.get(url, "INSST");
  assert.deepEqual([latin1.ok, latin1.title, latin1.headings], [true, "Guía", ["Título"]]);
});

// ---- Evaluación de citas web -------------------------------------------------------------------------
test("una web que responde NO queda verificada: como mínimo necesita revisión por vigencia no acreditable", async () => {
  const result = await verify(insst, cita());
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.reasons, ["vigencia_no_acreditable", "solo_existencia"]);
  assert.deepEqual(lockProblems(result.lock), []);
  assert.deepEqual([result.lock.engine, result.lock.status, result.lock.http_status, result.lock.content_type], ["web-v1", "needs_review", 200, "text/html"]);
  const window = contentWindow(htmlToText(FICHA), extractHeadings(FICHA));
  assert.equal(result.lock.content_sha256, sha256Hex(window), "HTML: huella de la ventana de contenido, no del HTML crudo");
  assert.equal(result.lock.text_sha256, sha256Hex(window));
  assert.deepEqual(result.lock.document, { final_url: insst.urls.document, content_type: "application/pdf", content_sha256: sha256Bytes(PDF), last_modified: "Thu, 19 Nov 2020 15:39:23 GMT" });
  assert.equal(result.lock.quote_sha256, null);
});

test("en HTML la cita debe aparecer literalmente; si no aparece, falla", async () => {
  const found = await verify(insstHtmlOnly, cita({ quote: QUOTE }));
  assert.deepEqual([found.status, found.reasons], ["needs_review", ["vigencia_no_acreditable"]]);
  assert.equal(found.lock.quote_sha256, sha256Hex(normalizeText(QUOTE)));
  const typographic = await verify(insstHtmlOnly, cita({ quote: "mandatando  al INSST a disponer de una guía, de carácter no vinculante […] la elaboración de dicho documento" }));
  assert.deepEqual(typographic.reasons, ["vigencia_no_acreditable"]);
  const missing = await verify(insstHtmlOnly, cita({ quote: "mandatando al INSST a disponer de una guía de carácter VINCULANTE y obligatorio" }));
  assert.deepEqual([missing.status, missing.reasons, missing.lock], ["failed", ["cita_no_encontrada"], undefined]);
});

test("una cita de un PDF no se puede comprobar: se marca para revisión y nunca como verificada", async () => {
  const withDocument = await verify(insst, cita({ quote: QUOTE })); // la ficha tiene PDF: la cita se refiere al PDF
  assert.deepEqual([withDocument.status, withDocument.reasons], ["needs_review", ["vigencia_no_acreditable", "pdf_sin_verificacion_textual"]]);
  const pdf = await verify(aepd, cita({ source: "aepd-guia-calidad-datos-ia", quote: "Cualquier frase que no podemos comprobar en el PDF." }));
  assert.deepEqual([pdf.status, pdf.reasons], ["needs_review", ["vigencia_no_acreditable", "pdf_sin_verificacion_textual"]]);
  assert.equal(pdf.lock.content_type, "application/pdf");
  assert.equal(pdf.lock.text_sha256, null);
  assert.equal(pdf.lock.content_sha256, sha256Bytes(PDF), "PDF: hash de los bytes");
  assert.equal(pdf.lock.last_modified, "Tue, 21 Jul 2026 06:54:38 GMT");
  assert.equal(pdf.lock.document, null);
  assert.deepEqual(lockProblems(pdf.lock), []);
});

test("el título oficial se comprueba contra la ficha o el listado: si no consta, se marca", async () => {
  const goodList = await verify(aepd, cita({ source: aepd.id }));
  assert.ok(!goodList.reasons.includes("titulo_no_coincide"));
  const otherList = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.index]: res({ body: "<html><title>Guías | AEPD</title><body><p>Otras guías distintas.</p></body></html>" }) }));
  assert.ok(otherList.reasons.includes("titulo_no_coincide"));
  const renamed = await verify(insst, cita(), hostRoutes({ [insst.urls.canonical]: res({ body: FICHA.replace(/Guía técnica para la Simplificación documental - Año 2012/g, "Otra guía distinta - Año 2030").replace(/simplificación documental/g, "otra cosa") }) }));
  assert.ok(renamed.reasons.includes("titulo_no_coincide"), "la URL responde pero no es la guía registrada");
});

test("el tipo de contenido y la URL final deben ser los esperados", async () => {
  const html = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ body: "<html><title>Aviso</title><p>No es un PDF</p></html>" }) }));
  assert.ok(html.reasons.includes("tipo_inesperado"));
  const wrongDocument = await verify(insst, cita(), hostRoutes({ [insst.urls.document]: res({ body: "<html><title>Aviso</title></html>" }) }));
  assert.ok(wrongDocument.reasons.includes("tipo_inesperado"));
  const moved = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 301, headers: { location: "/guias/nueva-ubicacion.pdf" } }), "https://www.aepd.es/guias/nueva-ubicacion.pdf": res({ type: "application/pdf", body: PDF }) }));
  assert.ok(moved.reasons.includes("url_redirigida"));
  assert.equal(moved.lock.final_url, "https://www.aepd.es/guias/nueva-ubicacion.pdf");
});

test("una URL inexistente o una redirección fuera del dominio oficial falla", async () => {
  const gone = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 404 }) }));
  assert.deepEqual([gone.status, gone.reasons, gone.lock], ["failed", ["url_inexistente"], undefined]);
  const noDocument = await verify(insst, cita(), hostRoutes({ [insst.urls.document]: res({ status: 410 }) }));
  assert.deepEqual([noDocument.status, noDocument.reasons], ["failed", ["url_inexistente"]]);
  const away = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 302, headers: { location: "https://example.com/guia.pdf" } }) }));
  assert.deepEqual([away.status, away.reasons], ["failed", ["redireccion_no_oficial"]]);
});

test("las fuentes inaccesibles son inconclusas: needs_review sin candado, nunca verified", async () => {
  const scenarios = {
    "403": res({ status: 403 }),
    "429": res({ status: 429 }),
    "500": res({ status: 500, body: fixture("aepd-bloqueado-500.html") }),
    "503": res({ status: 503 }),
    "red": new Error("ECONNRESET"),
    "bloqueo con 200": res({ body: fixture("aepd-bloqueado-500.html") }),
  };
  for (const [label, route] of Object.entries(scenarios)) {
    const result = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: route }));
    assert.deepEqual([result.status, result.reasons, result.inconclusive, result.lock], ["needs_review", ["fuente_inalcanzable"], true, undefined], label);
  }
  const robots = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ "https://www.aepd.es/robots.txt": res({ type: "text/plain", body: "User-agent: *\nDisallow: /guias/\n" }) }));
  assert.deepEqual([robots.status, robots.reasons, Boolean(robots.inconclusive)], ["needs_review", ["bloqueado_por_robots"], false]);
  const huge = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ type: "application/pdf", body: "x", headers: { "content-length": String(MAX_BYTES.pdf + 1) } }) }));
  assert.deepEqual([huge.status, huge.reasons], ["needs_review", ["fuente_demasiado_grande"]]);
  const broken = await verifyWebCitation({ client: { get: async () => { throw new Error("fallo interno"); } }, entry: aepd, citation: cita({ source: aepd.id }), now: NOW });
  assert.deepEqual([broken.status, broken.reasons, broken.inconclusive, broken.detail], ["needs_review", ["fuente_inalcanzable"], true, "fallo interno"]);
});

test("ningún resultado web es verified, ni siquiera con todo correcto y la cita encontrada", async () => {
  const outcomes = [
    await verify(insst, cita()),
    await verify(insstHtmlOnly, cita({ quote: QUOTE })),
    await verify(aepd, cita({ source: aepd.id })),
    await verify(aepd, cita({ source: aepd.id, quote: "Una cita cualquiera dentro del PDF" })),
    await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 404 }) })),
  ];
  assert.ok(outcomes.every((outcome) => outcome.status !== "verified" && !(outcome.lock && outcome.lock.status === "verified") && outcome.reasons.length > 0));
  assert.ok(outcomes.filter((o) => o.lock).every((o) => o.reasons.includes("vigencia_no_acreditable")));
});

test("evaluateWeb es pura: con los mismos datos da el mismo resultado", async () => {
  const { client } = clientFor(hostRoutes());
  const canonical = await client.get(insst.urls.canonical, "INSST");
  const document = await client.get(insst.urls.document, "INSST");
  const a = evaluateWeb({ entry: insst, citation: cita(), canonical, document, now: NOW });
  assert.deepEqual(a, evaluateWeb({ entry: insst, citation: cita(), canonical, document, now: NOW }));
});

// ---- Estabilidad de la huella de las páginas HTML (hallazgo con las páginas reales del INSST) -----------------
// El HTML crudo del INSST cambia en cada descarga por un token de sesión; los menús y la ventana de acceso rodean
// el contenido. La huella debe depender solo del contenido: de lo contrario toda comprobación daría deriva falsa.
test("la huella de una página HTML no depende del token de sesión, de los menús ni de la ventana de acceso", async () => {
  const volatile = FICHA.replace("<body>", "<body><script>Liferay.authToken = 'J4JufRZV';</script><div>Menú nuevo: Novedades Agenda Contacto</div>").replace("</body>", "<div>Introduzca su email: Introduzca su contraseña: Acceder</div><p>© 2031</p></body>");
  assert.notEqual(sha256Bytes(Buffer.from(volatile)), sha256Bytes(Buffer.from(FICHA)), "el HTML crudo sí cambia");
  const a = await verify(insst, cita());
  const b = await verify(insst, cita(), hostRoutes({ [insst.urls.canonical]: res({ body: volatile }) }));
  assert.equal(b.lock.content_sha256, a.lock.content_sha256, "la huella del contenido no cambia");
  assert.deepEqual(compareWebWithLock(b, a.lock).reasons, ["vigencia_no_acreditable", "solo_existencia"], "sin deriva falsa");
});

test("un cambio real dentro del contenido sí cambia la huella y se marca como fuente modificada", async () => {
  const edited = FICHA.replace("Código:", "Código modificado:").replace("GT.123", "GT.999");
  const a = await verify(insst, cita());
  const b = await verify(insst, cita(), hostRoutes({ [insst.urls.canonical]: res({ body: edited }) }));
  assert.notEqual(b.lock.content_sha256, a.lock.content_sha256);
  assert.ok(compareWebWithLock(b, a.lock).reasons.includes("fuente_modificada"));
});

test("contentWindow empieza en el primer h1, se limita en tamaño y sin h1 usa el comienzo del texto", () => {
  const text = `menú menú menú ${"x".repeat(100)} Título del documento ${"y".repeat(FINGERPRINT_CHARS * 2)}`;
  const window = contentWindow(text, ["Título del documento"]);
  assert.ok(window.startsWith("Título del documento y"));
  assert.equal(window.length, FINGERPRINT_CHARS);
  assert.equal(contentWindow("sin título aquí", []), "sin título aquí");
  assert.equal(contentWindow("abc", ["no aparece"]), "abc", "un h1 que no está en el texto no rompe nada");
  assert.equal(contentWindow(text, ["Título del documento"], 10), "Título del");
});

// ---- Comparación con el candado ---------------------------------------------------------------------------
test("compareWebWithLock: un cambio de contenido exige revisión; el registro modificado falla; lo inconcluso se mantiene", async () => {
  const live = await verify(insst, cita());
  const same = compareWebWithLock(live, live.lock);
  assert.deepEqual([same.status, same.reasons], ["needs_review", ["vigencia_no_acreditable", "solo_existencia"]]);
  for (const patch of [{ content_sha256: "e".repeat(64) }, { text_sha256: "e".repeat(64) }, { document: { ...live.lock.document, content_sha256: "e".repeat(64) } }]) {
    const changed = compareWebWithLock(live, { ...live.lock, ...patch });
    assert.deepEqual([changed.status, changed.reasons.includes("fuente_modificada")], ["needs_review", true], JSON.stringify(Object.keys(patch)));
  }
  assert.deepEqual(compareWebWithLock(live, { ...live.lock, source_sha256: "d".repeat(64) }).reasons, ["registro_modificado"]);
  const failed = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 404 }) }));
  assert.equal(compareWebWithLock(failed, live.lock).status, "failed");
  const inconclusive = await verify(aepd, cita({ source: aepd.id }), hostRoutes({ [aepd.urls.canonical]: res({ status: 503 }) }));
  assert.equal(compareWebWithLock(inconclusive, live.lock).inconclusive, true);
});
