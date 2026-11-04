'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const NFCloud = require('../android/assets/cloud.js');

const URL = 'https://abcdefghijk.supabase.co';
const KEY = 'sb_publishable_abcdefghijklmnopqrstuvwxyz';
const ID = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-000000000002';
const SESSION = {access_token:'old-access',refresh_token:'old-refresh',expires_at:4102444800,user:{id:ID,email:'ana@example.com'}};
const INVOICE = {id:ID,workspace_id:TEAM,client_name:'Ana',nf_number:'NF-42',billing_date:'2026-10-29',term_days:5,consultant:'Raimundo Sergio',amount_cents:125050,funding_source:'bank',bank_name:'Banco do Brasil',paid_at:null,created_at:'2026-10-29T12:00:00Z',updated_at:'2026-10-29T12:00:00Z',version:1};
const response = (status, body) => new Response(body === null ? null : JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}});
function transport(replies) {
  const calls=[];
  return {calls,fetch:async (url,init)=>{calls.push({url,init,body:init.body ? JSON.parse(init.body):null});const reply=replies.shift();if(reply instanceof Error) throw reply;if(!reply) throw new Error('Unexpected network call');return typeof reply === 'function' ? reply(url,init) : reply;}};
}
function client(t,extra={}) { return new NFCloud({url:URL,key:KEY,session:SESSION,fetch:t.fetch,...extra}); }

test('rejects unsafe endpoints and privileged or malformed keys before sending credentials',()=>{
  for(const url of ['http://abcdefghijk.supabase.co','https://evil.example','https://abcdefghijk.supabase.co.evil.example','https://u:p@abcdefghijk.supabase.co','https://abcdefghijk.supabase.co/path','https://abcdefghijk.supabase.co?token=x']) {
    assert.throws(()=>new NFCloud({url,key:KEY}),/configura|Supabase/i);
  }
  for(const key of ['', 'service_role', 'sb_secret_abcdefghijklmnopqrstuvwxyz','eyJhbGciOiJIUzI1NiJ9.'+Buffer.from('{"role":"service_role"}').toString('base64url')+'.signature']) {
    assert.throws(()=>new NFCloud({url:URL,key}),/chave|pública/i);
  }
});
test('uses auth endpoint and stores a password-free normalized login session',async()=>{
  const t=transport([response(200,{...SESSION,expires_in:3600,password:'must-not-persist'})]);const changes=[];
  const c=client(t,{session:null,onSession:s=>changes.push(s)});const session=await c.signIn(' ANA@example.com ','strong password');
  assert.equal(t.calls[0].url,URL+'/auth/v1/token?grant_type=password');
  assert.deepEqual(t.calls[0].body,{email:'ANA@example.com',password:'strong password'});
  assert.equal(session.access_token,'old-access');assert.equal(session.password,undefined);assert.equal(changes.length,1);
  assert.equal(t.calls[0].init.redirect,'error');assert.equal(t.calls[0].init.referrerPolicy,'no-referrer');
  assert.equal(t.calls[0].init.headers.Authorization,undefined);
});
test('signup reports confirmation requirement without fabricating a session',async()=>{
  const t=transport([response(200,{id:ID,email:'ana@example.com'})]);const c=client(t,{session:null});
  const result=await c.signUp('ana@example.com','strong password');
  assert.equal(result.confirmationRequired,true);assert.equal(result.session,null);assert.equal(c.session,null);
});
test('blocks unauthenticated mutations before any network call',async()=>{
  const t=transport([]);const c=client(t,{session:null});
  for(const operation of [()=>c.saveInvoice(INVOICE,null),()=>c.setPaid(ID,true,1),()=>c.deleteInvoice(ID,1),()=>c.ensureAccount()]) {
    await assert.rejects(operation,/Entre|sessão/i);
  }
  assert.equal(t.calls.length,0);
});
test('ensures one private account without exposing group or invite APIs',async()=>{
  const t=transport([response(200,{id:TEAM,name:'Meu controle',owner_id:ID,created_at:'2026-10-29T12:00:00Z'})]);
  assert.deepEqual(await client(t).ensureAccount(),{id:TEAM,name:'Meu controle'});
  assert.equal(t.calls[0].url,URL+'/rest/v1/rpc/ensure_account');
  assert.deepEqual(t.calls[0].body,{});
  assert.equal(t.calls[0].init.headers.Authorization,'Bearer old-access');
});
test('401 GET refreshes rotated session and retries once with the new token',async()=>{
  const fresh={...SESSION,access_token:'new-access',refresh_token:'new-refresh'};
  const t=transport([response(401,{message:'JWT expired'}),response(200,fresh),response(200,[INVOICE])]);const changes=[];
  const result=await client(t,{onSession:s=>changes.push(s)}).listInvoices(TEAM);
  assert.equal(result[0].nf_number,'NF-42');assert.equal(t.calls.length,3);
  assert.equal(t.calls[1].url,URL+'/auth/v1/token?grant_type=refresh_token');
  assert.deepEqual(t.calls[1].body,{refresh_token:'old-refresh'});
  assert.equal(t.calls[1].init.headers.Authorization,undefined);
  assert.equal(t.calls[2].init.headers.Authorization,'Bearer new-access');assert.equal(changes[0].refresh_token,'new-refresh');
});
test('expired sessions refresh before a mutation so an RPC executes once',async()=>{
  const t=transport([response(200,{...SESSION,access_token:'fresh',expires_at:4102444800}),response(200,INVOICE)]);
  await client(t,{session:{...SESSION,expires_at:1}}).saveInvoice(INVOICE,null);
  assert.equal(t.calls.length,2);assert.match(t.calls[0].url,/grant_type=refresh_token/);assert.match(t.calls[1].url,/rpc\/save_invoice$/);
});
test('401 mutation refreshes credentials but never blindly replays the write',async()=>{
  const t=transport([response(401,{message:'JWT expired'}),response(200,{...SESSION,access_token:'new-access'})]);
  await assert.rejects(()=>client(t).saveInvoice(INVOICE,null),error=>error.code==='AUTH_RETRY' && /novamente/i.test(error.message));
  assert.equal(t.calls.length,2);assert.match(t.calls[0].url,/rpc\/save_invoice$/);assert.match(t.calls[1].url,/grant_type=refresh_token/);
});
test('network failure on mutation does not replay and warns to refresh before another write',async()=>{
  const t=transport([new Error('network old-access secret-credentials')]);
  await assert.rejects(()=>client(t).setPaid(ID,true,1),error=>/atualiz|conexão/i.test(error.message) && !error.message.includes('secret-credentials'));
  assert.equal(t.calls.length,1);
});
test('saves known validated fields and expected version, excluding server audit and payment fields',async()=>{
  const t=transport([response(200,{...INVOICE,version:2})]);
  const result=await client(t).saveInvoice({...INVOICE,version:999,actor_id:'forged',paid_at:'2020-01-01',admin:true},1);
  assert.equal(result.version,2);assert.deepEqual(t.calls[0].body,{p_invoice:{id:ID,workspace_id:TEAM,client_name:'Ana',nf_number:'NF-42',billing_date:'2026-10-29',term_days:5,consultant:'Raimundo Sergio',amount_cents:125050,funding_source:'bank',bank_name:'Banco do Brasil'},p_expected_version:1});
});
test('invalid dates, lengths, terms and versions are rejected before network writes',async()=>{
  const t=transport([]);const c=client(t);
  for(const patch of [{billing_date:'2025-02-29'},{billing_date:'2026-13-01'},{term_days:0.2},{term_days:-1},{term_days:3651},{client_name:' '},{nf_number:'x'.repeat(81)},{workspace_id:'other-account'},{consultant:'x'.repeat(161)},{amount_cents:0},{amount_cents:1.5},{amount_cents:100000000000},{amount_cents:'100'},{funding_source:'cash'},{bank_name:''},{bank_name:'x'.repeat(81)}]) {
    await assert.rejects(()=>c.saveInvoice({...INVOICE,...patch},1));
  }
  await assert.rejects(()=>c.setPaid(ID,'true',1));await assert.rejects(()=>c.deleteInvoice(ID,null));assert.equal(t.calls.length,0);
});
test('conflict maps to a Portuguese action message without returning backend details',async()=>{
  const t=transport([response(409,{code:'40001',message:'NF_CONFLICT',details:'internal secret'})]);
  await assert.rejects(()=>client(t).saveInvoice(INVOICE,1),error=>error.code==='CONFLICT' && /atualiz/i.test(error.message) && !error.message.includes('secret'));
});
test('invalid refresh clears session and stops further protected requests',async()=>{
  const t=transport([response(401,{message:'JWT expired'}),response(400,{error:'invalid_grant',error_description:'Invalid Refresh Token'})]);const changes=[];
  const c=client(t,{onSession:s=>changes.push(s)});await assert.rejects(()=>c.listInvoices(TEAM),/sessão|Entre/i);
  assert.equal(c.session,null);assert.deepEqual(changes,[null]);assert.equal(t.calls.length,2);
});
test('payment/delete use the exact versioned RPC parameter contract',async()=>{
  const t=transport([response(200,INVOICE),response(200,INVOICE)]);const c=client(t);
  await c.setPaid(ID,false,3);await c.deleteInvoice(ID,4);
  assert.deepEqual(t.calls.map(c=>c.body),[{p_id:ID,p_paid:false,p_expected_version:3},{p_id:ID,p_expected_version:4}]);
});
test('own funds clear a previously selected bank in the saved payload',async()=>{
  const t=transport([response(200,INVOICE)]);
  await client(t).saveInvoice({...INVOICE,funding_source:'own',bank_name:'Old bank'},1);
  assert.equal(t.calls[0].body.p_invoice.bank_name,'');
});
test('events endpoint is restricted to one validated workspace and ordered for history',async()=>{
  const t=transport([response(200,[{invoice_id:ID,workspace_id:TEAM,client_name:'Ana',nf_number:'NF-42',action:'deleted',details:{},actor_id:ID}])]);
  const events=await client(t).listEvents(TEAM);assert.equal(events[0].action,'deleted');
  assert.match(t.calls[0].url,new RegExp('workspace_id=eq\\.'+TEAM));assert.match(t.calls[0].url,/order=created_at.desc/);
});
test('logout always clears local session even if the remote service is unavailable',async()=>{
  const t=transport([new Error('offline')]);const changes=[];const c=client(t,{onSession:s=>changes.push(s)});
  await c.signOut();assert.equal(c.session,null);assert.deepEqual(changes,[null]);
});

test('v2 dynamic consultant fields and explicit due dates use the existing versioned save contract',async()=>{
  const t=transport([response(200,INVOICE)]);await client(t).saveInvoice({...INVOICE,consultant:'Nova consultora',consultant_id:ID,client_id:TEAM,due_date:'2026-11-03'},1);
  assert.equal(t.calls[0].body.p_invoice.consultant,'Nova consultora');assert.equal(t.calls[0].body.p_invoice.consultant_id,ID);assert.equal(t.calls[0].body.p_invoice.due_date,'2026-11-03');
});

test('v2 entity reads are restricted to a validated account',async()=>{
  const t=transport([response(200,[]),response(200,[]),response(200,[]),response(200,{hour:9})]);const c=client(t);
  await c.listConsultants(TEAM);await c.listImports(TEAM);await c.listNotifications(TEAM);await c.getBillingSettings(TEAM);
  for(const call of t.calls.slice(0,3)) assert.match(call.url,new RegExp('workspace_id=eq\\.'+TEAM));
  assert.deepEqual(t.calls[3].body,{p_workspace_id:TEAM});
});

test('v2 consultant, cancellation, rules and notification RPC payloads exclude forged state',async()=>{
  const t=transport(Array.from({length:5},()=>response(200,{id:ID})));const c=client(t);
  await c.saveConsultant({id:ID,workspace_id:TEAM,name:'Maria',phone:'+5571999999999',email:'',active:true,notifications_enabled:true,whatsapp_authorized:false,version:999,admin:true},2);
  await c.cancelInvoice(ID,true,2);
  const rules={before_days:1,on_due:true,after_days:1,repeat_days:3,hour:9,daily_summary:true};await c.saveBillingSettings(TEAM,rules);
  await c.recordNotification({workspace_id:TEAM,invoice_id:ID,consultant_id:ID,channel:'whatsapp_manual',status:'prepared',message:'Olá',phone:'+5571999999999',confirmed_at:'forged'});
  await c.confirmNotification(ID);
  assert.equal(t.calls[0].body.p_expected_version,2);assert.equal(t.calls[0].body.p_consultant.admin,undefined);assert.equal(t.calls[0].body.p_consultant.version,undefined);
  assert.deepEqual(t.calls[1].body,{p_id:ID,p_cancelled:true,p_expected_version:2});
  assert.deepEqual(t.calls[2].body,{p_workspace_id:TEAM,p_rules:rules});assert.equal(t.calls[3].body.p_notification.confirmed_at,undefined);assert.deepEqual(t.calls[4].body,{p_id:ID});
});

test('v2 import preserves a caller batch UUID for explicit safe retry and validates all rows before fetch',async()=>{
  const batch={id:ID,file_name:'notas.xlsx',rows:[{...INVOICE,consultant:'',funding_source:'unspecified'}],total_count:1,error_count:0,duplicate_count:0,ignored_count:0};
  const t=transport([response(200,{import:{id:ID},imported:[],duplicates:[],consultants:[]})]);const c=client(t);
  await c.importInvoices(TEAM,batch);assert.equal(t.calls[0].body.p_batch.id,ID);assert.equal(t.calls[0].body.p_batch.rows[0].funding_source,'unspecified');assert.equal(t.calls[0].body.p_batch.rows[0].paid_at,undefined);
  await assert.rejects(()=>c.importInvoices(TEAM,{...batch,rows:[{...INVOICE,amount_cents:0}]}));assert.equal(t.calls.length,1);
});
