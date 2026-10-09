// Comprobación estática (PV-WEB-I18N-OG-001, fase 1): Open Graph, canonical,
// favicon, robots.txt, sitemap.xml y su presencia en la allowlist de Pages.
// Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";

const BASE = "https://legalprevent.com";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readBytes = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));

const allowlist = new Set(
  read(".github/pages-allowlist.txt")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
);

// Páginas indexables → URL canónica.
const INDEXABLE = {
  "index.html": "/",
  "partner/index.html": "/partner/",
  "diagnostico/index.html": "/diagnostico/",
  "aviso-legal/index.html": "/aviso-legal/",
  "politica-privacidad/index.html": "/politica-privacidad/",
  "politica-cookies/index.html": "/politica-cookies/",
  "terminos-condiciones/index.html": "/terminos-condiciones/",
  "documentacion-legal/index.html": "/documentacion-legal/",
};
const ICONS = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"];

const meta = (html, attr, key) => {
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[:.]/g, "\\$&")}"\\s+content="([^"]*)"`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
};
const links = (html, rel) =>
  [...html.matchAll(new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, "g"))].map((m) => m[1]);
const publishedPath = (url) => url.replace(BASE, "").replace(/^\//, "");

function jpegSize(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "no es un JPEG");
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG sin cabecera SOF");
}

test("cada página indexable tiene canonical, Open Graph completo y Twitter Card", () => {
  for (const [file, path] of Object.entries(INDEXABLE)) {
    const html = read(file);
    const url = BASE + path;
    assert.deepEqual(links(html, "canonical"), [url], `${file}: un único canonical`);
    assert.deepEqual(meta(html, "property", "og:url"), [url], `${file}: og:url = canonical`);
    assert.equal(meta(html, "property", "og:title").length, 1, `${file}: og:title`);
    assert.equal(meta(html, "property", "og:description").length, 1, `${file}: og:description`);
    assert.deepEqual(meta(html, "property", "og:site_name"), ["LegalPrevent"], file);
    assert.deepEqual(meta(html, "property", "og:locale"), ["es_ES"], file);
    assert.deepEqual(meta(html, "property", "og:image:width"), ["1200"], file);
    assert.deepEqual(meta(html, "property", "og:image:height"), ["630"], file);
    assert.equal(meta(html, "property", "og:image:alt").length, 1, `${file}: og:image:alt`);
    assert.deepEqual(meta(html, "name", "twitter:card"), ["summary_large_image"], file);
    assert.doesNotMatch(html, /<meta\s+name="robots"[^>]*noindex/, `${file} no debe llevar noindex`);
  }
});

test("og:image es una URL absoluta https publicada, JPEG 1200×630 y < 300 KB", () => {
  const images = new Set();
  for (const file of [...Object.keys(INDEXABLE), "gracias/index.html"]) {
    const [image] = meta(read(file), "property", "og:image");
    assert.ok(image?.startsWith(`${BASE}/`), `${file}: og:image absoluta en ${BASE}`);
    images.add(image);
  }
  for (const image of images) {
    const path = publishedPath(image);
    assert.ok(allowlist.has(path), `${path} debe estar en la allowlist`);
    const bytes = readBytes(path);
    assert.deepEqual(jpegSize(bytes), { width: 1200, height: 630 }, path);
    assert.ok(statSync(new URL(`../${path}`, import.meta.url)).size < 300 * 1024, `${path} < 300 KB (WhatsApp)`);
  }
});

test("favicon: los iconos enlazados existen, están publicados y son válidos", () => {
  for (const file of [...Object.keys(INDEXABLE), "gracias/index.html", "crm/index.html"]) {
    const html = read(file);
    const hrefs = [...links(html, "icon"), ...links(html, "apple-touch-icon")];
    assert.deepEqual(hrefs.sort(), [...ICONS].sort(), `${file}: iconos`);
  }
  for (const icon of ICONS) {
    const path = icon.slice(1);
    assert.ok(exists(path), `${path} existe`);
    assert.ok(allowlist.has(path), `${path} en la allowlist`);
  }
  const ico = readBytes("favicon.ico");
  assert.equal(ico.readUInt16LE(2), 1, "favicon.ico: tipo icono");
  assert.ok(ico.readUInt16LE(4) >= 2, "favicon.ico: varios tamaños");
  assert.match(read("favicon.svg"), /^<svg[^>]+viewBox="0 0 34 34"/);
  const png = readBytes("apple-touch-icon.png");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [180, 180], "apple-touch-icon 180×180");
});

test("gracias sigue en noindex y sin canonical; el CRM queda en noindex", () => {
  const thanks = read("gracias/index.html");
  assert.match(thanks, /<meta name="robots" content="noindex,follow" \/>/);
  assert.deepEqual(links(thanks, "canonical"), []);
  const crm = read("crm/index.html");
  assert.match(crm, /<meta name="robots" content="noindex,nofollow" \/>/);
  assert.equal(meta(crm, "property", "og:image").length, 0, "el CRM no se anuncia en redes");
});

test("robots.txt permite rastrear (incluido el noindex del CRM) y anuncia el sitemap", () => {
  const robots = read("robots.txt");
  assert.doesNotMatch(robots, /^Disallow:\s*\/\s*$/m, "no bloquear todo el sitio");
  assert.doesNotMatch(robots, /^Disallow:.*crm/im, "si se bloquea /crm/, Google no ve su noindex");
  assert.match(robots, new RegExp(`^Sitemap: ${BASE}/sitemap.xml$`, "m"));
});

test("sitemap.xml contiene exactamente las páginas indexables publicadas", () => {
  const locs = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = [...Object.values(INDEXABLE), "/en/", "/en/partner/", "/en/diagnostico/"].map((path) => BASE + path);
  assert.deepEqual([...locs].sort(), [...expected].sort());
  for (const [file] of Object.entries(INDEXABLE)) assert.ok(allowlist.has(file), `${file} en la allowlist`);
  assert.ok(!locs.some((loc) => /gracias|crm/.test(loc)), "ni gracias ni CRM en el sitemap");
});

test("la allowlist solo apunta a ficheros existentes y sin rutas peligrosas", () => {
  for (const path of allowlist) {
    assert.ok(!path.includes("..") && !path.startsWith("/"), `ruta no permitida: ${path}`);
    assert.ok(exists(path), `falta en el repositorio: ${path}`);
  }
});
