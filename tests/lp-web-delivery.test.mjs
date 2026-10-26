import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { leadFromSupabaseRow, validateLead, dashboardMetrics } from '../crm/src/store.js?v=20261001-2';
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');

// Executes the real landing submit handler; every external operation is replaced.
function landing(result) {
  let submit;
  const feedback={textContent:''}, button={disabled:false}, calls=[],timers=[];
  const form={dataset:{form:'demo'},reportValidity:()=>true,querySelector:s=>s==='.form-feedback'?feedback:button,addEventListener:(_,fn)=>{submit=fn;}};
  const window={location:{href:'https://legalprevent.com/'},setTimeout:fn=>timers.push(fn),LegalPreventSupabase:{createLead:async input=>{calls.push(input);return result;}}};
  const context=vm.createContext({window,document:{querySelector:s=>s==='[data-cookie-banner]'?{}:null,querySelectorAll:s=>s==='form[data-form]'?[form]:[],body:{insertAdjacentHTML(){}}},localStorage:{getItem:()=>null},FormData:class{entries(){return [['email','QA@example.invalid'],['privacy','on']][Symbol.iterator]();}},Date,JSON,Object,String,console});
  vm.runInContext(read('script.js'),context);
  return {run:()=>submit({preventDefault(){}}),calls,feedback,button,timers,window};
}
test('demo request submits Nuevo, no inferred plan or risk, and redirects only after acceptance',async()=>{
  const page=landing({ok:true,email:{ok:true}});await page.run();
  assert.equal(page.calls[0].lead.status,'Nuevo');assert.equal(page.calls[0].lead.recommendedPlan,'');assert.equal(page.calls[0].lead.riskScore,null);
  assert.equal(page.calls[0].eventType,'demo_requested');assert.equal(page.calls[0].lead.email,'qa@example.invalid');
  assert.equal(page.timers.length,1);page.timers[0]();assert.equal(page.window.location.href,'./gracias/?origen=demo');
});
test('rejected or rate limited demo does not show confirmation and permits retry',async()=>{
  for(const result of [{ok:false},{ok:false,reason:'rate_limited'},undefined]){
    const page=landing(result);await page.run();assert.equal(page.timers.length,0);assert.equal(page.button.disabled,false);assert.match(page.feedback.textContent,/legal@legalprevent.com/);
  }
});
test('CRM distinguishes unknown risk from zero and counts a landing request without a scheduled appointment',()=>{
  const row={id:'synthetic',company_name:'QA',email:'qa@example.invalid',source:'demo_requested',status:'Nuevo',created_at:'2026-10-26T12:00:00Z',risk_score:null};
  const lead=leadFromSupabaseRow(row);
  assert.equal(lead.riskScore,null);assert.equal(lead.demoRequestedAt,row.created_at);assert.equal(lead.demoAt,'');
  assert.equal(leadFromSupabaseRow({...row,risk_score:0}).riskScore,0);
  const metrics=dashboardMetrics({leads:[lead],clients:[],tasks:[],users:[]});assert.equal(metrics.demosRequested,1);assert.equal(metrics.demosScheduled,0);
});
test('CRM requires a dated appointment before saving Demo agendada',()=>{
  const lead={companyName:'QA',contactName:'QA',email:'qa@example.invalid',status:'Demo agendada',priority:'Media',riskScore:null};
  assert.throws(()=>validateLead(lead),/Confirma la fecha/);
  assert.throws(()=>validateLead({...lead,demoAt:'invalid'}),/Confirma la fecha/);
  assert.doesNotThrow(()=>validateLead({...lead,demoAt:'2026-11-01T10:00:00Z'}));
  assert.doesNotThrow(()=>validateLead({...lead,status:'Nuevo'}));
});
test('ES and EN exclude unauthorised social proof and absolute promises; examples are labelled',()=>{
  for(const file of ['index.html','en/index.html']){
    const html=read(file);assert.doesNotMatch(html,/Novaline|Altair Group|Medixia|UrbanOps|Northbit|testimonial-card|Evita sanciones|Prevent penalties|soporte profesional ampliado|enhanced professional support|4\.8x|31h|41 horas|41 hours/);
    assert.match(html,/Datos ficticios|Fictional data/);
  }
});
