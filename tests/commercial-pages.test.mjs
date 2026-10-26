import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../'+path, import.meta.url),'utf8');
const routes = ['intelligence','academy','escudito','recursos/normas','recursos/normas/une-19601','recursos/normas/iso-37301','recursos/normas/iso-27001','recursos/normas/iso-42001'];
const allow = new Set(read('.github/pages-allowlist.txt').split('\n').filter(x=>x&&!x.startsWith('#')));
test('commercial ES/EN pages have reciprocal alternates, one heading, and published internal links and anchors',()=>{
  for(const prefix of ['', 'en/']) for(const route of routes) {
    const file=prefix+route+'/index.html', html=read(file);
    assert.ok(allow.has(file),file);
    assert.equal((html.match(/<h1>/g)||[]).length,1,file);
    for(const lang of ['es','en','x-default']) assert.ok(html.includes(`hreflang="${lang}" href="https://legalprevent.com/${lang==='en'?'en/':''}${route}/"`),file);
    assert.ok(html.includes(`rel="canonical" href="https://legalprevent.com/${prefix}${route}/"`),file);
    for(const [,attr,value] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
      const url=new URL(value.replaceAll('&amp;','&'),'https://legalprevent.com/'+prefix+route+'/');
      if(url.origin!=='https://legalprevent.com') continue;
      const target=url.pathname.endsWith('/')?url.pathname.slice(1)+'index.html':url.pathname.slice(1);
      assert.ok(allow.has(target),`${file}: unpublished ${attr} ${value}`);
      if(url.hash) assert.ok(read(target).includes(`id="${url.hash.slice(1)}"`),`${file}: missing anchor ${value}`);
    }
  }
});
test('widget loading policy and commercial qualification limits are explicit in ES/EN',()=>{
  const es=read('intelligence/index.html'), en=read('en/intelligence/index.html');
  assert.match(es,/agent-widget.js/); assert.doesNotMatch(en,/<script[^>]+agent-widget/);
  assert.match(read('academy/index.html'),/No es un título oficial/);
  assert.match(read('en/academy/index.html'),/not an official qualification/);
  assert.match(read('escudito/index.html'),/No introduzcas datos sensibles/);
  assert.match(es,/Completar una actuación no acredita cumplimiento/);
  for(const route of routes.slice(4)) {
    assert.match(read(route+'/index.html'),/LegalPrevent no es una entidad certificadora/);
    assert.match(read('en/'+route+'/index.html'),/LegalPrevent is not a certification body/);
  }
});
