'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('../test-tools/node_modules/@electric-sql/pglite');
const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002';
const INVOICE='00000000-0000-4000-8000-000000000010';
test('real PostgreSQL enforces single-account isolation, financial validation, versions and durable audit', async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${A}'),('${B}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
  await db.exec(fs.readFileSync(path.join(__dirname,'../backend/schema.sql'),'utf8'));
  async function user(id,role='authenticated') {
    await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id || '']);await db.exec('SET ROLE '+role);
  }
  async function call(name,args=[]) {
    return (await db.query('SELECT * FROM public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)).rows[0];
  }
  let accountA,accountB,invoice;
  const data=()=>({id:INVOICE,workspace_id:accountA.id,client_name:'Nome original',nf_number:'NF original',billing_date:'2026-10-29',term_days:5,consultant:'Raimundo Sergio',amount_cents:125050,funding_source:'bank',bank_name:'Banco do Brasil'});
  await t.test('same login reuses the same account across fresh device sessions',async()=>{
    await user(A);accountA=await call('ensure_account');assert.equal(accountA.name,'Meu controle');
    await user(null);await user(A);assert.equal((await call('ensure_account')).id,accountA.id);
    await user(B);accountB=await call('ensure_account');assert.notEqual(accountA.id,accountB.id);
    assert.deepEqual((await db.query('SELECT id FROM public.workspaces')).rows.map(x=>x.id),[accountB.id]);
  });
  if (!accountA || !accountB) return;
  await t.test('anonymous callers and sessions without auth.uid cannot access RPCs',async()=>{
    await user(null,'anon');await assert.rejects(()=>call('ensure_account'),/permission denied/);
    await user(null);await assert.rejects(()=>call('ensure_account'),/NF_ACCESS/);
    await assert.rejects(()=>call('save_invoice',[data(),null]),/NF_ACCESS/);
  });
  await t.test('direct writes and audit trigger entry points are inaccessible',async()=>{
    await user(A);
    for(const sql of ["INSERT INTO public.workspaces(owner_id) VALUES ('"+A+"')",'DELETE FROM public.workspaces',"UPDATE public.invoices SET client_name='Bypass'",'DELETE FROM public.invoices','DELETE FROM public.invoice_events','TRUNCATE public.invoice_events',"INSERT INTO public.invoice_events DEFAULT VALUES",'SELECT public.nf_audit_invoice()']) await assert.rejects(()=>db.exec(sql),/permission denied/);
  });
  await t.test('invoices and events are visible only to the account owner',async()=>{
    await user(A);invoice=await call('save_invoice',[data(),null]);assert.equal(invoice.version,1);assert.equal(invoice.paid_at,null);assert.equal(Number(invoice.amount_cents),125050);
    await user(B);assert.equal((await db.query('SELECT * FROM public.invoices')).rows.length,0);assert.equal((await db.query('SELECT * FROM public.invoice_events')).rows.length,0);
    await assert.rejects(()=>call('set_invoice_paid',[INVOICE,true,1]),/NF_ACCESS/);
    await assert.rejects(()=>call('delete_invoice',[INVOICE,1]),/NF_ACCESS/);
    await assert.rejects(()=>call('save_invoice',[{...data(),workspace_id:accountB.id},1]),/NF_ACCESS/);
  });
  await t.test('concurrent device edits reject stale versions without changing data or audit',async()=>{
    await user(A);invoice=await call('save_invoice',[{...data(),client_name:'Nome novo',nf_number:'NF nova',funding_source:'own',bank_name:''},1]);assert.equal(invoice.version,2);
    await user(A);await assert.rejects(()=>call('save_invoice',[{...data(),client_name:'Stale'},1]),/NF_CONFLICT/);
    assert.equal((await db.query('SELECT client_name FROM public.invoices')).rows[0].client_name,'Nome novo');assert.equal((await db.query('SELECT count(*)::int AS n FROM public.invoice_events')).rows[0].n,2);
  });
  await t.test('payment is server-timestamped, versioned and idempotent at the current version',async()=>{
    await user(A);invoice=await call('set_invoice_paid',[INVOICE,true,2]);assert.equal(invoice.version,3);assert.ok(invoice.paid_at);
    await assert.rejects(()=>call('set_invoice_paid',[INVOICE,false,2]),/NF_CONFLICT/);
    invoice=await call('set_invoice_paid',[INVOICE,false,3]);assert.equal(invoice.version,4);assert.equal(invoice.paid_at,null);assert.equal((await call('set_invoice_paid',[INVOICE,false,4])).version,4);
    assert.deepEqual((await db.query('SELECT action FROM public.invoice_events ORDER BY created_at,id')).rows.map(e=>e.action),['created','updated','paid','reopened']);
  });
  await t.test('deletion preserves historical identity and financial snapshots',async()=>{
    await assert.rejects(()=>call('delete_invoice',[INVOICE,3]),/NF_CONFLICT/);
    const removed=await call('delete_invoice',[INVOICE,4]);assert.equal(removed.nf_number,'NF nova');assert.equal((await db.query('SELECT * FROM public.invoices')).rows.length,0);
    const events=(await db.query('SELECT * FROM public.invoice_events ORDER BY created_at,id')).rows;
    assert.equal(events.length,5);assert.equal(events[0].client_name,'Nome original');assert.equal(events[0].nf_number,'NF original');assert.equal(events[0].details.after.amount_cents,125050);
    assert.equal(events[4].action,'deleted');assert.equal(events[4].details.before.client_name,'Nome novo');assert.equal(events[4].actor_id,A);assert.equal(events[0].invoice_id,INVOICE);
  });
  await t.test('server rejects forged fields, invalid financing, dates, terms, amounts and versions',async()=>{
    await user(A);const valid={...data()};delete valid.id;
    for(const patch of [{billing_date:'2025-02-29'},{billing_date:'2026-1-1'},{billing_date:'1800-01-01'},{term_days:3651},{term_days:1.5},{term_days:'5'},{client_name:' '},{client_name:'x\n'},{paid_at:'2020-01-01'},{actor_id:B},{consultant:'Other'},{amount_cents:0},{amount_cents:-1},{amount_cents:1.5},{amount_cents:'100'},{amount_cents:100000000000},{funding_source:'cash'},{bank_name:''},{bank_name:'x'.repeat(81)},{funding_source:'own',bank_name:'Old bank'}]) await assert.rejects(()=>call('save_invoice',[{...valid,...patch},null]),/NF_VALIDATION/);
    for(const consultant of ['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira']) {const created=await call('save_invoice',[{...valid,consultant},null]);assert.equal(created.consultant,consultant);}
    const created=await call('save_invoice',[valid,null]);
    await assert.rejects(()=>call('save_invoice',[{...valid,id:created.id,workspace_id:accountB.id},1]),/NF_ACCESS/);
    await assert.rejects(()=>call('save_invoice',[{...valid,id:created.id},null]),/NF_CONFLICT/);
    await assert.rejects(()=>call('set_invoice_paid',[created.id,true,null]),/NF_VALIDATION/);
  });
  await t.test('audit history cannot be rewritten or truncated even by the migration owner',async()=>{
    await db.exec('RESET ROLE');for(const sql of ["UPDATE public.invoice_events SET client_name='Changed'",'DELETE FROM public.invoice_events','TRUNCATE public.invoice_events']) await assert.rejects(()=>db.exec(sql),/NF_IMMUTABLE/);
  });
});
