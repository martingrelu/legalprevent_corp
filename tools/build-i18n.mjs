import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const dictionary = JSON.parse(read('i18n/en.json'));
const normalise = text => text.replace(/\s+/g, ' ').trim();
const escape = text => text.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]));
const translate = text => dictionary[normalise(decode(text))] ?? decode(text);
const pages = ['index.html', 'partner/index.html', 'diagnostico/index.html', 'gracias/index.html'];
const routes = new Map(pages.map(path => [path === 'index.html' ? '/' : '/' + path.replace(/index\.html$/, ''), '/en/' + (path === 'index.html' ? '' : path.replace(/index\.html$/, ''))]));
const outputs = new Map();
const alternate = route => `<link rel="alternate" hreflang="es" href="https://legalprevent.com${route}" />\n    <link rel="alternate" hreflang="en" href="https://legalprevent.com${routes.get(route)}" />\n    <link rel="alternate" hreflang="x-default" href="https://legalprevent.com${route}" />`;

for (const file of pages) {
  const route = file === 'index.html' ? '/' : '/' + file.replace(/index\.html$/, '');
  const base = new URL(route, 'https://legalprevent.com');
  let source = read(file);
  source = source.replace(/<nav class="language-switch"[^]*?<\/nav>/g, '');
  source = source.replace(/<meta property="og:locale:alternate"[^>]+>\s*/g, '');
  // Implicit option values must be made explicit before translating labels.
  source = source.replace(/<option(?![^>]*\bvalue=)([^>]*)>([^<]*)<\/option>/g, (_, attrs, text) => `<option${attrs} value="${escape(decode(text).trim())}">${text}</option>`);
  source = source.replace(/<script\b[^>]*src=["'][^"']*agent-widget\.js[^"']*["'][^>]*>\s*<\/script>/g, '');
  let english = source.replace(/<!--[^]*?-->|<script\b[^]*?<\/script>|<[^>]+>|[^<]+/gi, token => {
    if (token.startsWith('<!--')) return token;
    if (/^<script\b/i.test(token)) {
      if (/application\/ld\+json/.test(token)) {
        const start = token.indexOf('>') + 1, end = token.lastIndexOf('</script>');
        const walk = value => typeof value === 'string' ? (value.startsWith('https://legalprevent.com') ? rewrite(value) : translate(value)) : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,walk(item)])) : value;
        const schema = walk(JSON.parse(token.slice(start,end)));
        schema.inLanguage = 'en-GB';
        return token.slice(0,start) + JSON.stringify(schema,null,2) + token.slice(end);
      }
      return token.replace(/\bsrc="([^"]+)"/g, (_, url) => `src="${rewrite(url)}"`);
    }
    if (token.startsWith('<')) return token.replace(/\b(href|src|content|aria-label|placeholder|alt)="([^"]*)"/g, (_, attr, value) => {
      if (attr === 'href' || attr === 'src') return `${attr}="${rewrite(value)}"`;
      if (value === 'es_ES') return `${attr}="en_GB"`;
      if (value.includes('og-es-v1.jpg')) return `${attr}="${value.replace('og-es-v1.jpg','og-en-v1.jpg')}"`;
      if (attr === 'content' && value.startsWith('https://legalprevent.com')) return `${attr}="${rewrite(value)}"`;
      return `${attr}="${escape(translate(value))}"`;
    }).replace('<html lang="es">','<html lang="en">');
    const clean = normalise(decode(token));
    if (!clean) return token;
    if (/[A-Za-zÀ-ÿ]/.test(clean) && !Object.hasOwn(dictionary, clean)) throw new Error(`Missing translation in ${file}: ${clean}`);
    const translated = translate(token);
    if (translated === decode(token)) return token;
    return token.match(/^\s*/)[0] + escape(translated) + token.match(/\s*$/)[0];
  });
  function rewrite(value) {
    if (!value || value.startsWith('#') || /^(?:mailto:|tel:|data:)/.test(value)) return value;
    const url = new URL(decode(value),base);
    if (url.origin !== base.origin) return value;
    const path = url.pathname.replace(/index\.html$/, '');
    const rewritten = (routes.get(path) ?? url.pathname) + url.search + url.hash;
    return value.startsWith('https://legalprevent.com') ? base.origin + rewritten : rewritten;
  }
  english = english.replace(/<link rel="alternate"[^>]+>\s*/g,'');
  if (!file.startsWith('gracias/')) english = english.replace('</head>', `    ${alternate(route)}\n    <meta property="og:locale:alternate" content="es_ES" />\n  </head>`);
  english = english.replace('</head>', '    <script src="/i18n/en-runtime.js"></script>\n  </head>');
  const selector = `<nav class="language-switch" aria-label="Language"><a href="${route}" lang="es" hreflang="es">ES <span>Español</span></a><a href="${routes.get(route)}" lang="en" hreflang="en" aria-current="page">EN <span>English</span></a></nav>`;
  english = english.replace('</header>',selector + '\n    </header>');
  english = english.replace(/(<label\b[^>]*>\s*<input name="privacy")/g, '<p class="form-privacy-note">LEGALPREVENT uses your details to respond to your enquiry and provide your assessment. Marketing communications are optional. To exercise your data protection rights or withdraw consent, email <a href="mailto:legal@legalprevent.com">legal@legalprevent.com</a>. Further information is available in our <a href="/politica-privacidad/">Privacy Policy (Spanish)</a>.</p>\n$1');
  if (/legalprevent\.legal\/comprar/.test(english)) english = english.replace('</main>','<p class="language-note section-shell">Checkout and the subscription platform are currently available in Spanish.</p>\n    </main>');
  outputs.set('en/' + file, english.replace(/[ \t]+$/gm, ''));
}

// The runtime dictionary only translates presentation. Canonical form values,
// scoring and Supabase payloads are never passed through the translator.
outputs.set('i18n/en-runtime.js', `(() => {\nconst dictionary = ${JSON.stringify(dictionary)};\n${read('tools/i18n-runtime-source.js')}\n})();\n`);

const indexed = ['/', '/partner/', '/diagnostico/', '/aviso-legal/', '/politica-privacidad/', '/politica-cookies/', '/terminos-condiciones/', '/documentacion-legal/'];
const sitemapUrls = [...indexed, ...[...routes.entries()].filter(([route])=>route!=='/gracias/').map(([,route])=>route)];
outputs.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemapUrls.map(route=>{
  const spanish = route.startsWith('/en/') ? [...routes.entries()].find(([,en])=>en===route)[0] : route;
  const links = routes.has(spanish) ? ['es','en','x-default'].map(lang=>`<xhtml:link rel="alternate" hreflang="${lang}" href="https://legalprevent.com${lang==='en'?routes.get(spanish):spanish}" />`).join('') : '';
  return `  <url><loc>https://legalprevent.com${route}</loc>${links}</url>`;
}).join('\n')}\n</urlset>\n`);

let stale = false;
for (const [path, content] of outputs) {
  if (process.argv.includes('--check')) {
    try { if (read(path) === content) continue; } catch {}
    console.error('Regenerate:',path); stale = true;
  } else {
    mkdirSync(dirname(resolve(root,path)),{recursive:true});
    writeFileSync(resolve(root,path),content);
  }
}
if (stale) process.exitCode = 1;
