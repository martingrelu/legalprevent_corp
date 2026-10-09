import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = new URL('../',import.meta.url);
const read = path => readFileSync(new URL(path,root),'utf8');
const dictionary = JSON.parse(read('i18n/en.json'));
const routes = [['index.html','/'],['partner/index.html','/partner/'],['diagnostico/index.html','/diagnostico/'],['gracias/index.html','/gracias/']];
const attributes = (html,tag,attribute) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]*)"`,'g'))].map(match=>match[1]);

test('generated English pages and sitemap match the source and dictionary',()=>{
  execFileSync(process.execPath,['tools/build-i18n.mjs','--check'],{cwd:root});
});
test('English links, metadata, legal links and checkout preserve their intended destinations',()=>{
  for (const [file,route] of routes) {
    const es=read(file),en=read('en/'+file);
    assert.match(en,/<html lang="en">/);
    assert.match(en,/og:locale" content="en_GB"/);
    assert.match(en,/og-en-v1\.jpg/);
    assert.doesNotMatch(en,/<script[^>]+agent-widget/);
    assert.deepEqual(attributes(en,'a','href').filter(url=>url.includes('legalprevent.legal')),attributes(es,'a','href').filter(url=>url.includes('legalprevent.legal')));
    assert.match(en,/href="\/politica-privacidad\/"/);
    assert.match(en,/Privacy(?: Policy)? \(Spanish\)/);
    if (file.startsWith('gracias/')) assert.match(en,/noindex,follow/);
    else {
      const own='https://legalprevent.com/en'+route;
      assert.ok(en.includes(`rel="canonical" href="${own}"`));
      assert.ok(en.includes(`property="og:url" content="${own}"`));
      for (const html of [es,en]) {
        assert.ok(html.includes(`hreflang="es" href="https://legalprevent.com${route}"`));
        assert.ok(html.includes(`hreflang="en" href="${own}"`));
      }
    }
  }
});
test('English select labels retain Spanish form values, including more than 250 employees',()=>{
  for(const file of ['index.html','diagnostico/index.html']) {
    const en=read('en/'+file);
    for(const [source,target] of [['Hostelería','Hospitality'],['Más de 250','Over 250'],['Gestorías','Accounting and HR advisory firms']]) {
      assert.ok(en.includes(`value="${source}">${target}</option>`));
    }
  }
});

function diagnostic(lang) {
  const fakeElement={addEventListener(){}};
  const context=vm.createContext({
    window:{LegalPreventI18n:{t:value=>dictionary[value]??value},scrollTo(){}},
    document:{documentElement:{lang},querySelector:selector=>selector==='[data-diagnostic-app]'?fakeElement:null,querySelectorAll:()=>[]},
    sessionStorage:{getItem:()=>null},Intl,Date:class extends Date{constructor(...args){super(...(args.length?args:['2026-10-10T00:00:00Z']));}},
    Blob,Uint8Array,console
  });
  vm.runInContext('const dictionary = '+JSON.stringify(dictionary)+';'+read('tools/i18n-runtime-source.js').split('const translateNode')[0],context);
  const source=read('diagnostico/diagnostico.js').replace('  renderQuestions();','  window.testApi = {state,calculateResult,buildPayload,buildCrmLead,parseEmployees,createProfessionalPdfBlob};\n  renderQuestions();');
  vm.runInContext(source,context);
  const api=context.window.testApi;
  api.state.company={company:'Example Ltd',email:'qa@example.invalid',phone:'000',sector:'Hostelería',employees:'Más de 250',privacy:'on'};
  for(let index=0;index<21;index++)api.state.answers[index]=index%3===0?'no':index%3===1?'partial':'yes';
  api.calculateResult();
  return api;
}
test('English and Spanish assessments produce identical canonical payloads and CRM leads',()=>{
  const es=diagnostic('es'),en=diagnostic('en');
  assert.equal(JSON.stringify(en.buildPayload()),JSON.stringify(es.buildPayload()));
  assert.equal(JSON.stringify(en.buildCrmLead()),JSON.stringify(es.buildCrmLead()));
  assert.equal(en.parseEmployees('Más de 250'),251);
});
test('the English report translates presentation and keeps company data',async()=>{
  const api=diagnostic('en');
  const pdf=await api.createProfessionalPdfBlob(api.buildPayload()).text();
  assert.match(pdf,/Preventive assessment report/);
  assert.match(pdf,/Example Ltd/);
  assert.doesNotMatch(pdf,/Informe de diagnóstico|Resumen ejecutivo|Puntuación global/);
});
test('all English resources are published and thank-you pages stay out of the sitemap',()=>{
  const allowlist=new Set(read('.github/pages-allowlist.txt').split('\n').map(line=>line.trim()));
  for(const file of [...routes.map(([file])=>'en/'+file),'i18n/en-runtime.js','language.js','assets/og/og-en-v1.jpg'])assert.ok(allowlist.has(file));
  assert.doesNotMatch(read('sitemap.xml'),/<loc>[^<]*(?:gracias|crm)/);
});
