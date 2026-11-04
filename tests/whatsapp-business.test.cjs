'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PGlite}=require('../test-tools/node_modules/@electric-sql/pglite');
const USER='20000000-0000-4000-8000-000000000001';

test('official WhatsApp preparation is backend-only, durable and disabled until explicitly configured',async t=>{
  const source=path.join(__dirname,'../backend/whatsapp-business.cjs');
  assert.ok(fs.existsSync(source),'official backend adapter must be prepared');
  const {PgOutboxStore,WhatsAppBusinessAdapter,verifyWebhookSignature}=require(source);
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${USER}');CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;GRANT USAGE ON SCHEMA auth TO authenticated;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;`);
  for(const file of ['schema.sql','migrations/002_v2.sql','migrations/003_whatsapp_business.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../backend',file),'utf8'));
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[USER]);
  const account=(await db.query('SELECT * FROM public.ensure_account()')).rows[0];
  const consultant=(await db.query('SELECT * FROM public.save_consultant($1,NULL)',[{workspace_id:account.id,name:'Contato autorizado',phone:'+5571999999999',email:'',active:true,notifications_enabled:true,whatsapp_authorized:true}])).rows[0];
  async function invoice(nf) {return (await db.query('SELECT * FROM public.save_invoice($1,NULL)',[{workspace_id:account.id,client_name:'Cliente',nf_number:nf,billing_date:'2026-10-29',term_days:5,consultant:'',consultant_id:consultant.id,amount_cents:10000,funding_source:'own',bank_name:''}])).rows[0];}
  const note=await invoice('OFFICIAL');
  await db.query('INSERT INTO public.whatsapp_settings(workspace_id) VALUES($1)',[account.id]);
  let tick=new Date('2026-11-03T12:00:00Z');const calls=[];let replies=[];
  const fakeFetch=async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});const reply=replies.shift();if(reply instanceof Error)throw reply;if(!reply)throw Error('No real network is permitted');return new Response(JSON.stringify(reply.body),{status:reply.status});};
  const store=new PgOutboxStore(db);
  const config={store,fetch:fakeFetch,enabled:true,adminAuthorized:true,accessToken:'server-secret-token',appSecret:'server-app-secret',phoneNumberId:'123456789',apiVersion:'v99.0',maxAttempts:3,ratePerMinute:10,now:()=>new Date(tick)};
  const adapter=new WhatsAppBusinessAdapter(config);
  const job=(target=note,occurrence='2026-11-03')=>({workspace_id:account.id,invoice_id:target.id,rule:'overdue',occurrence,template:{name:'notaflow_overdue',language:'pt_BR',parameters:['Cliente','OFFICIAL','100,00','03/11/2026']}});
  async function configure(enabled=true,templates=[{name:'notaflow_overdue',language:'pt_BR'}]) {await db.query('UPDATE public.whatsapp_settings SET enabled=$2,approved_templates=$3 WHERE workspace_id=$1',[account.id,enabled,JSON.stringify(templates)]);}

  await t.test('default disabled, missing admin enable, template and opt-in cannot queue or call Meta',async()=>{
    assert.equal((await new WhatsAppBusinessAdapter({store,fetch:fakeFetch}).enqueue(job())).queued,false);
    assert.equal((await new WhatsAppBusinessAdapter({...config,adminAuthorized:false}).enqueue(job())).queued,false);
    assert.equal((await adapter.enqueue(job())).queued,false);await configure(true,[]);assert.equal((await adapter.enqueue(job())).queued,false);
    await configure();await db.query('UPDATE public.consultants SET whatsapp_authorized=false WHERE id=$1',[consultant.id]);assert.equal((await adapter.enqueue(job())).queued,false);
    await db.query('UPDATE public.consultants SET whatsapp_authorized=true WHERE id=$1',[consultant.id]);assert.equal(calls.length,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.whatsapp_outbox')).rows[0].n,0);
  });
  await t.test('persistent dedupe and leases allow one provider attempt and record only actual acceptance',async()=>{
    const queued=await adapter.enqueue(job());assert.equal(queued.queued,true);assert.equal((await adapter.enqueue(job())).id,queued.id);
    const leased=await store.claim({now:tick,leaseSeconds:60,ratePerMinute:10,maxAttempts:3});assert.equal(leased.id,queued.id);
    assert.equal(await store.claim({now:tick,leaseSeconds:60,ratePerMinute:10,maxAttempts:3}),null);
    replies.push({status:200,body:{messages:[{id:'wamid.accepted-1'}]}});await adapter.deliver(leased);
    const row=(await db.query('SELECT * FROM public.whatsapp_outbox WHERE id=$1',[queued.id])).rows[0];assert.equal(row.status,'accepted');assert.equal(row.provider_message_id,'wamid.accepted-1');assert.equal(row.attempt_count,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.whatsapp_attempts WHERE outbox_id=$1',[queued.id])).rows[0].n,1);
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://graph.facebook.com/v99.0/123456789/messages');assert.equal(calls[0].body.type,'template');assert.equal(calls[0].body.to,'5571999999999');
    assert.equal(calls[0].options.headers.Authorization,'Bearer server-secret-token');assert.equal(row.provider_status,null);
  });
  await t.test('paid, cancelled and disabled consultant records are rechecked after claiming',async()=>{
    const second=await invoice('SUPPRESS');const queued=await adapter.enqueue(job(second));const leased=await store.claim({now:tick,leaseSeconds:60,ratePerMinute:10,maxAttempts:3});
    await db.query('SELECT * FROM public.set_invoice_paid($1,true,1)',[second.id]);await adapter.deliver(leased);
    assert.equal((await db.query('SELECT status FROM public.whatsapp_outbox WHERE id=$1',[queued.id])).rows[0].status,'suppressed');assert.equal(calls.length,1);
    const cancelled=await invoice('CANCEL');await db.query('SELECT * FROM public.cancel_invoice($1,true,1)',[cancelled.id]);assert.equal((await adapter.enqueue(job(cancelled))).queued,false);
    await db.query('UPDATE public.consultants SET notifications_enabled=false WHERE id=$1',[consultant.id]);assert.equal((await adapter.enqueue(job(note,'2026-11-04'))).queued,false);await db.query('UPDATE public.consultants SET notifications_enabled=true WHERE id=$1',[consultant.id]);
  });
  await t.test('429 retries are scheduled, rate-limited and bounded; ambiguous network outcomes never replay',async()=>{
    const retryNote=await invoice('RETRY');const retry=await adapter.enqueue(job(retryNote));
    for(let attempt=1;attempt<=3;attempt++) {
      replies.push({status:429,body:{error:{code:130429}}});await adapter.process({limit:1});
      const row=(await db.query('SELECT * FROM public.whatsapp_outbox WHERE id=$1',[retry.id])).rows[0];assert.equal(row.attempt_count,attempt);assert.equal(row.status,attempt===3?'failed':'retry');
      tick=new Date(tick.getTime()+3600000);
    }
    const uncertain=await adapter.enqueue(job(await invoice('UNKNOWN')));replies.push(new Error('timeout server-secret-token'));
    await adapter.process({limit:1});assert.equal((await db.query('SELECT status FROM public.whatsapp_outbox WHERE id=$1',[uncertain.id])).rows[0].status,'unknown');
    const count=calls.length;tick=new Date(tick.getTime()+86400000);await adapter.process({limit:20});assert.equal(calls.length,count);
    assert.ok(!(await db.query('SELECT * FROM public.whatsapp_status_events')).rows.some(row=>JSON.stringify(row).includes('server-secret-token')));
    const one=await adapter.enqueue(job(await invoice('RATE1')));await adapter.enqueue(job(await invoice('RATE2')));replies.push({status:200,body:{messages:[{id:'wamid.rate1'}]}});
    await new WhatsAppBusinessAdapter({...config,ratePerMinute:1}).process({limit:20});assert.equal((await db.query("SELECT count(*)::int AS n FROM public.whatsapp_outbox WHERE status='pending'")).rows[0].n,1);assert.equal((await db.query('SELECT status FROM public.whatsapp_outbox WHERE id=$1',[one.id])).rows[0].status,'accepted');
  });
  await t.test('raw webhook HMAC rejects tampering and stores provider delivery events idempotently',async()=>{
    const raw=Buffer.from(JSON.stringify({entry:[{changes:[{value:{statuses:[{id:'wamid.accepted-1',status:'delivered',timestamp:'1793707200'}]}}]}]}));
    const signature='sha256='+crypto.createHmac('sha256','server-app-secret').update(raw).digest('hex');
    assert.equal(verifyWebhookSignature(raw,signature,'server-app-secret'),true);assert.equal(verifyWebhookSignature(Buffer.concat([raw,Buffer.from(' ')]),signature,'server-app-secret'),false);
    await assert.rejects(()=>adapter.handleWebhook(raw,'sha256=bad'),/signature/i);
    await adapter.handleWebhook(raw,signature);await adapter.handleWebhook(raw,signature);
    const delivered=(await db.query("SELECT provider_status FROM public.whatsapp_outbox WHERE provider_message_id='wamid.accepted-1'")).rows[0];assert.equal(delivered.provider_status,'delivered');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.whatsapp_status_events WHERE event_type='provider_delivered'")).rows[0].n,1);
  });
  await t.test('clients cannot enable the adapter or mutate outbox/attempt history',async()=>{
    await db.exec('SET ROLE authenticated');for(const table of ['whatsapp_settings','whatsapp_outbox','whatsapp_attempts','whatsapp_status_events']) await assert.rejects(()=>db.exec('DELETE FROM public.'+table),/permission denied/);
    await db.exec('RESET ROLE');for(const table of ['whatsapp_attempts','whatsapp_status_events']) {await assert.rejects(()=>db.exec('DELETE FROM public.'+table),/NF_IMMUTABLE/);await assert.rejects(()=>db.exec('TRUNCATE public.'+table),/NF_IMMUTABLE/);}
  });
});
