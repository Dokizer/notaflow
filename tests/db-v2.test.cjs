'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('../test-tools/node_modules/@electric-sql/pglite');
const A='10000000-0000-4000-8000-000000000001', B='10000000-0000-4000-8000-000000000002';
const NOTE='10000000-0000-4000-8000-000000000010', NOTE2='10000000-0000-4000-8000-000000000011';
const BATCH='10000000-0000-4000-8000-000000000020';

test('v2 upgrades a populated 1.1 database and enforces the new account contract',async t=>{
  const migration=path.join(__dirname,'../backend/migrations/002_v2.sql');
  assert.ok(fs.existsSync(migration),'v2 additive migration is required');
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${A}'),('${B}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
  await db.exec(fs.readFileSync(path.join(__dirname,'../backend/schema.sql'),'utf8'));
  async function user(id,role='authenticated') {await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('SET ROLE '+role);}
  async function call(name,args=[]) {return (await db.query('SELECT * FROM public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)).rows[0];}
  const base={client_name:'José  Silva',nf_number:'00042',billing_date:'2026-10-29',term_days:5,consultant:'Raimundo Sergio',amount_cents:125050,funding_source:'own',bank_name:''};
  await user(A);const aa=await call('ensure_account');
  const legacy={...base,id:NOTE,workspace_id:aa.id};
  await call('save_invoice',[legacy,null]);await call('set_invoice_paid',[NOTE,true,1]);
  await call('save_invoice',[{...legacy,id:NOTE2,client_name:' JOSE SILVA ',nf_number:'42'},null]);
  const before=(await db.query('SELECT to_jsonb(i) AS value FROM public.invoices i ORDER BY id')).rows.map(r=>r.value);
  const history=(await db.query('SELECT * FROM public.invoice_events ORDER BY id')).rows;
  await db.exec('RESET ROLE');await db.exec(fs.readFileSync(migration,'utf8'));
  await user(A);const after=(await db.query('SELECT to_jsonb(i) AS value FROM public.invoices i ORDER BY id')).rows.map(r=>r.value);
  for(let i=0;i<before.length;i++) for(const key of Object.keys(before[i])) assert.deepEqual(after[i][key],before[i][key],key+' must survive migration');
  assert.deepEqual((await db.query('SELECT * FROM public.invoice_events ORDER BY id')).rows,history);
  assert.equal(after[0].consultant_id,null);assert.equal(after[0].due_date,null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.consultants')).rows[0].n,5);
  await user(B);const bb=await call('ensure_account');
  let consultant,created;
  await t.test('dynamic consultants validate and remain isolated/versioned',async()=>{
    await user(A);consultant=await call('save_consultant',[{workspace_id:aa.id,name:'Consultora nova',phone:'+5571999999999',email:'nova@example.com',active:true,notifications_enabled:true,whatsapp_authorized:false},null]);
    assert.equal(consultant.version,1);assert.equal(consultant.whatsapp_authorized,false);
    await assert.rejects(()=>call('save_consultant',[{...consultant,name:'Mudança'},0]),/NF_VALIDATION/);
    const edit={id:consultant.id,workspace_id:aa.id,name:'Consultora editada',phone:consultant.phone,email:consultant.email,active:true,notifications_enabled:true,whatsapp_authorized:false};
    consultant=await call('save_consultant',[edit,1]);assert.equal(consultant.version,2);
    await assert.rejects(()=>call('save_consultant',[edit,1]),/NF_CONFLICT/);
    await user(B);assert.equal((await db.query('SELECT * FROM public.consultants WHERE id=$1',[consultant.id])).rows.length,0);
    await assert.rejects(()=>call('save_consultant',[{...edit,workspace_id:bb.id},2]),/NF_ACCESS/);
  });
  await t.test('new invoices snapshot dynamic names, retain optional links and reject cross-account links',async()=>{
    await user(A);created=await call('save_invoice',[{...base,workspace_id:aa.id,nf_number:'NEW',consultant_id:consultant.id,consultant:'forged',due_date:'2026-11-03'},null]);
    assert.equal(created.consultant,'Consultora editada');assert.equal(created.consultant_id,consultant.id);assert.ok(created.client_id);
    await assert.rejects(()=>call('save_invoice',[{...base,workspace_id:aa.id,nf_number:'wrong due',due_date:'2026-11-04'},null]),/NF_VALIDATION/);
    await user(B);await assert.rejects(()=>call('save_invoice',[{...base,workspace_id:bb.id,consultant_id:consultant.id},null]),/NF_ACCESS/);
    await assert.rejects(()=>call('save_invoice',[{...base,workspace_id:bb.id,client_id:created.client_id},null]),/NF_ACCESS/);
    await user(A);const empty=await call('save_invoice',[{...base,workspace_id:aa.id,nf_number:'NO CONSULTANT',consultant:''},null]);assert.equal(empty.consultant_id,null);assert.equal(empty.consultant,'');
    await assert.rejects(()=>call('save_invoice',[{...base,workspace_id:aa.id,nf_number:'00000042',client_name:'Jose Silva'},null]),/NF_DUPLICATE/);
    // Same presentation can be retained while editing a legacy duplicate.
    const edited=await call('save_invoice',[{...legacy,id:NOTE2},1]);assert.equal(edited.version,2);
  });
  await t.test('batch import skips normalized legacy duplicates and is idempotent across retries',async()=>{
    await user(A);const payload={id:BATCH,file_name:'entrada.xlsx',total_count:4,error_count:1,duplicate_count:0,ignored_count:1,rows:[{...base,nf_number:'000042',client_name:'jose silva',consultant:''},{...base,nf_number:'00043',client_name:'Cliente importado',consultant:'Nome importado',funding_source:'unspecified'}]};
    const result=(await call('import_invoices',[aa.id,payload])).import_invoices;
    assert.equal(result.import.imported_count,1);assert.equal(result.import.duplicate_count,1);assert.equal(result.import.error_count,1);assert.equal(result.import.ignored_count,1);
    assert.equal(result.duplicates[0].index,0);assert.equal(result.imported[0].nf_number,'00043');assert.equal(result.consultants[0].name,'Nome importado');
    assert.deepEqual((await call('import_invoices',[aa.id,payload])).import_invoices,result);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.imports')).rows[0].n,1);
    await assert.rejects(()=>call('import_invoices',[aa.id,{...payload,file_name:'different.xlsx'}]),/NF_CONFLICT/);
    await user(B);await assert.rejects(()=>call('import_invoices',[aa.id,payload]),/NF_ACCESS/);assert.equal((await db.query('SELECT * FROM public.imports')).rows.length,0);
    await user(A);const n=(await db.query('SELECT count(*)::int AS n FROM public.invoices')).rows[0].n;
    await assert.rejects(()=>call('import_invoices',[aa.id,{...payload,id:'10000000-0000-4000-8000-000000000021',rows:[{...base,nf_number:'rollback'},{...base,amount_cents:0}]}]),/NF_VALIDATION/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.invoices')).rows[0].n,n);
    const decomposed={...base,client_name:'Jose\u0301   Silva',nf_number:'0000042',consultant:''};
    const repeat=(await call('import_invoices',[aa.id,{...payload,id:'10000000-0000-4000-8000-000000000022',rows:[decomposed],total_count:1,error_count:0,ignored_count:0}])).import_invoices;
    assert.equal(repeat.import.imported_count,0);assert.equal(repeat.import.duplicate_count,1);
    const nbsp=(await call('import_invoices',[aa.id,{...payload,id:'10000000-0000-4000-8000-000000000024',rows:[{...decomposed,client_name:'\u00a0José\u00a0 Silva\u00a0'}],total_count:1,error_count:0,ignored_count:0}])).import_invoices;
    assert.equal(nbsp.import.imported_count,0);assert.equal(nbsp.import.duplicate_count,1);
    const pipes=(await call('import_invoices',[aa.id,{...payload,id:'10000000-0000-4000-8000-000000000023',rows:[{...base,client_name:'A|B',nf_number:'C'},{...base,client_name:'A',nf_number:'B|C'}],total_count:2,error_count:0,ignored_count:0}])).import_invoices;
    assert.equal(pipes.import.imported_count,2);assert.equal(pipes.import.duplicate_count,0);
  });
  await t.test('billing settings validate and manual history suppresses paid/cancelled/inactive notes',async()=>{
    await user(A);const rules={before_days:2,on_due:true,after_days:1,repeat_days:3,hour:9,daily_summary:true};
    assert.deepEqual((await call('save_billing_settings',[aa.id,rules])).save_billing_settings,rules);
    await assert.rejects(()=>call('save_billing_settings',[aa.id,{...rules,hour:24}]),/NF_VALIDATION/);
    const record={workspace_id:aa.id,invoice_id:created.id,consultant_id:consultant.id,channel:'whatsapp_manual',message:'Cobrança preparada',phone:consultant.phone,status:'prepared'};
    const notification=await call('record_notification',[record]);assert.equal(notification.status,'prepared');assert.equal(notification.confirmed_at,null);
    const confirmed=await call('confirm_notification',[notification.id]);assert.equal(confirmed.status,'confirmed_by_user');assert.ok(confirmed.confirmed_at);
    created=await call('cancel_invoice',[created.id,true,1]);assert.ok(created.cancelled_at);assert.equal(created.version,2);
    await assert.rejects(()=>call('record_notification',[record]),/NF_INELIGIBLE/);
    await assert.rejects(()=>call('cancel_invoice',[created.id,false,1]),/NF_CONFLICT/);
    await assert.rejects(()=>call('record_notification',[{...record,invoice_id:NOTE}]),/NF_INELIGIBLE/);
    const legacyContact=(await db.query("SELECT * FROM public.consultants WHERE name='Raimundo Sergio'")).rows[0];
    await call('save_consultant',[{id:legacyContact.id,workspace_id:aa.id,name:legacyContact.name,phone:consultant.phone,email:'',active:true,notifications_enabled:true,whatsapp_authorized:false},1]);
    assert.equal((await call('record_notification',[{...record,invoice_id:NOTE2,consultant_id:legacyContact.id}])).status,'prepared');
    await assert.rejects(()=>call('record_notification',[{...record,invoice_id:NOTE2}]),/NF_ACCESS/);
    await user(B);assert.equal((await db.query('SELECT * FROM public.notifications')).rows.length,0);await assert.rejects(()=>call('confirm_notification',[notification.id]),/NF_ACCESS/);
    await user(A);for(const table of ['clients','consultants','imports','notifications','billing_settings']) await assert.rejects(()=>db.exec('DELETE FROM public.'+table),/permission denied/);
    await user(null,'anon');await assert.rejects(()=>call('save_consultant',[{},null]),/permission denied/);await assert.rejects(()=>call('import_invoices',[aa.id,{}]),/permission denied/);
    await db.exec('RESET ROLE');for(const sql of ['DELETE FROM public.invoice_events','TRUNCATE public.invoice_events','DELETE FROM public.imports','TRUNCATE public.imports']) await assert.rejects(()=>db.exec(sql),/NF_IMMUTABLE/);
  });
});
