const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../android/assets/core.js');
const source = fs.readFileSync(path.join(__dirname,'../android/assets/app.js'),'utf8');

function bootstrap({raw=null,readError=false,native=true,Cloud=class {},Importer,Worker,writeError=false,localLog=[],whatsappResult=true}={}) {
  const elements = {}, listeners = {}, writes = [], caches = [], notifications = [], files = [], windowListeners = {}, timers=[], contexts=[], composers=[];
  let permissionRequests = 0;
  const element = id => elements[id] ||= {innerHTML:'',textContent:'',hidden:true,style:{},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},insertAdjacentHTML(_,html){this.innerHTML+=html;},querySelector(){return null;}};
  const document = {hidden:false,body:{style:{}},getElementById:element,addEventListener(name,fn){listeners[name]=fn;}};
  const Native = native ? {readState(){if(readError)throw new Error('Keystore unavailable');return raw;},writeState(value){if(writeError)throw Error('Storage full');writes.push(JSON.parse(value));},cacheInvoices(value){caches.push(value);},cacheContext(value){contexts.push(JSON.parse(value));},readNotificationLog(){return JSON.stringify(localLog);},openWhatsApp(phone,message){composers.push({phone,message});if(whatsappResult instanceof Error)throw whatsappResult;return whatsappResult;},notificationsEnabled(){return false;},requestNotifications(){permissionRequests++;},paymentNotification(client,number){notifications.push({client,number,cache:caches.at(-1)});},shareFile(name,content,mime){files.push({name,content,mime});}} : undefined;
  const storage = {getItem(){if(readError)throw new Error('Storage denied');return raw;},setItem(_,value){writes.push(JSON.parse(value));}};
  const window = {NFCore:core,NFImporter:Importer,Worker,NF_CONFIG:{},NFCloud:Cloud,Native,addEventListener(name,fn){windowListeners[name]=fn;},scrollTo(){},location:{reload(){}}};
  const context = {window,document,navigator:{onLine:true},localStorage:storage,setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},setInterval(){return 1;},console,Date,Map,Set,JSON,Promise,URL,atob,FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key];}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}}};
  vm.runInNewContext(source,context,{filename:'app.js'});
  return {elements,listeners,windowListeners,writes,caches,notifications,files,timers,contexts,composers,submitForm(id,values,dataset={}){listeners.submit({target:{id,values,dataset,matches(){return true;},querySelector(){return {disabled:false,isConnected:true};}},preventDefault(){}});return new Promise(resolve=>setImmediate(resolve));},get permissionRequests(){return permissionRequests;},click(action,extra={}){listeners.click({target:{closest(){return {disabled:false,dataset:{action,...extra}};}}});},navigate(tab){listeners.click({target:{closest(){return {disabled:false,dataset:{tab}};}}});},submit(values,{id='',version=''}={}){const form={id:'invoice-form',values,dataset:{id,version},matches(){return true;},querySelector(){return {disabled:false,isConnected:true};}};listeners.submit({target:form,preventDefault(){}});return new Promise(resolve=>setImmediate(resolve));}};
}

function spreadsheetApp(options={}) {
  const workers=[],previews=[];
  class Worker {constructor(url){this.url=url;workers.push(this);}postMessage(msg){this.message=msg;}terminate(){this.terminated=true;}}
  const Importer={FIELDS:[{key:'client_name',label:'Cliente',required:true},{key:'nf_number',label:'Nota fiscal',required:true}],suggestMapping(){return {client_name:0,nf_number:1};},preview(table,options){previews.push(options);return {rows:[{sourceRow:2,status:'valid',value:{client_name:'<Cliente>',nf_number:'1'},errors:[],warnings:['Origem não informada']},{sourceRow:3,status:'duplicate',value:{client_name:'Duplicado'},errors:['Já cadastrada'],warnings:[]},{sourceRow:4,status:'invalid',value:{},errors:['Data inválida'],warnings:[]}],valid:[{client_name:'Cliente Importado',nf_number:'0005',billing_date:'2026-11-03',term_days:5,due_date:'2026-11-08',amount_cents:10000,consultant:'Ana Nova',consultant_phone:'5571999991234',funding_source:'unspecified',bank_name:'',paid_at:null}],counts:{total:3,valid:1,duplicate:1,invalid:1,empty:0}};}};
  return {...bootstrap({...options,Importer,Worker}),workers,previews};
}
const sheetTable={filename:'notas.xlsx',sheets:[{index:0,name:'Notas'},{index:1,name:'Outro'}],sheetIndex:0,headers:[{index:0,label:'Razão Social'},{index:1,label:'NF'}],rows:[]};
test('spreadsheet preview maps columns, displays counters and warnings without saving any data',async()=>{
  const app=spreadsheetApp();app.click('spreadsheet');assert.match(app.elements.main.innerHTML,/Importar Planilha/);
  app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'notas.xlsx',size:100,arrayBuffer:async()=>new ArrayBuffer(5)}]}});await flush();
  const worker=app.workers[0];assert.equal(worker.url,'import-worker.js');worker.onmessage({data:{id:worker.message.id,ok:true,table:sheetTable}});
  const html=app.elements.main.innerHTML;assert.match(html,/1 válidas/);assert.match(html,/1 duplicadas/);assert.match(html,/1 com erros/);assert.match(html,/Origem não informada/);assert.match(html,/&lt;Cliente&gt;/);assert.match(html,/import-mapping-client_name/);
  app.listeners.change({target:{id:'import-mapping-client_name',dataset:{importField:'client_name'},value:'1'}});assert.equal(app.previews.at(-1).mapping.client_name,1);
  assert.equal(app.writes.length,0);assert.equal(worker.terminated,true);
});
test('spreadsheet worker can be cancelled or timed out, ignores stale replies and rejects oversized files',async()=>{
  const app=spreadsheetApp(),file={name:'notas.csv',size:100,arrayBuffer:async()=>new ArrayBuffer(5)};
  app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[file]}});await flush();const first=app.workers[0];app.click('cancel-import');first.onmessage({data:{id:first.message.id,ok:true,table:sheetTable}});assert.equal(first.terminated,true);assert.doesNotMatch(app.elements.main.innerHTML,/Razão Social/);
  app.listeners.change({target:{id:'spreadsheet-file',files:[file]}});await flush();app.timers.filter(t=>t.ms===15000).at(-1).fn();assert.match(app.elements.main.innerHTML,/15 segundos/);
  app.listeners.change({target:{id:'spreadsheet-file',files:[{...file,size:6*1024*1024}]}});await flush();assert.equal(app.workers.length,2);assert.match(app.elements.main.innerHTML,/5 MB/);assert.equal(app.writes.length,0);
});
test('replacing a spreadsheet during file reading cannot attach stale bytes to the newer file',async()=>{
  const app=spreadsheetApp();let resolveOld;app.click('spreadsheet');
  app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'old.csv',size:1,arrayBuffer:()=>new Promise(resolve=>resolveOld=resolve)}]}});
  app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'new.csv',size:1,arrayBuffer:async()=>Uint8Array.of(2).buffer}]}});await flush();
  resolveOld(Uint8Array.of(1).buffer);await flush();assert.equal(app.workers.length,1);assert.equal(app.workers[0].message.filename,'new.csv');assert.equal(new Uint8Array(app.workers[0].message.bytes)[0],2);assert.equal(app.writes.length,0);
});

test('unreadable encrypted storage keeps saved data protected and never clears native cache',()=>{
  const app=bootstrap({readError:true});
  assert.match(app.elements.main.innerHTML,/Vamos recuperar seu espaço/);
  assert.equal(app.writes.length,0);assert.equal(app.caches.length,0);
  app.click('new');assert.equal(app.writes.length,0);assert.ok(!app.elements.overlay || !app.elements.overlay.innerHTML);
});

test('corrupt browser JSON and malformed saved collections cannot reset the app silently',()=>{
  for(const raw of ['{bad json','null','[]','{"invoices":"broken"}','{"cloud":"broken"}','{"cloud":{"workspaces":"broken"}}','{"invoices":[{}]}']){
    const app=bootstrap({raw,native:false});assert.match(app.elements.main.innerHTML,/Vamos recuperar seu espaço/,raw);assert.equal(app.writes.length,0,raw);assert.equal(app.caches.length,0,raw);
  }
});

test('invalid persisted cloud configuration opens editable settings instead of crashing',()=>{
  const app=bootstrap({raw:JSON.stringify({invoices:[],events:[],settings:{defaultTerm:5},cloud:{url:'https://wrong.example.com',key:'public',session:null},mode:'local'}),Cloud:class{constructor(){throw new Error('URL do projeto inválida.');}}});
  assert.match(app.elements.main.innerHTML,/Revise a configuração de sincronização/);
  assert.match(app.elements.main.innerHTML,/backend-form/);
  assert.equal(app.writes.length,0);
});

test('invalid new cloud configuration is rejected before any state is persisted',async()=>{
  const app=bootstrap({Cloud:class{constructor(){throw new Error('URL do projeto inválida.');}}});
  const submit={disabled:false,isConnected:true};
  const form={id:'backend-form',values:{url:'https://wrong.example.com',key:'public'},matches(){return true;},querySelector(){return submit;}};
  app.listeners.submit({target:form,preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.writes.length,0);
  assert.equal(submit.disabled,false);
});

test('fresh startup stays local, clearly labels device storage and needs no cloud account',()=>{
  const app=bootstrap();assert.match(app.elements.main.innerHTML,/Modo local/);assert.match(app.elements.main.innerHTML,/Seu fluxo, em dia/);assert.equal(app.writes.length,0);assert.equal(app.caches.length,1);
});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const validFields=()=>({client_name:'Cliente Aurora',nf_number:'123',billing_date:'2026-10-20',term_days:'5',consultant:'Raimundo Sergio',amount:'1.234,56',funding_source:'bank',bank_name:'Banco do Brasil'});
const invoice=(extra={})=>({id:'11111111-1111-4111-8111-111111111111',client_name:'Cliente Aurora',nf_number:'123',billing_date:'2026-10-20',term_days:5,paid_at:null,created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z',version:1,...extra});

test('new form offers seeded dynamic consultants, required amount and conditional funding fields',()=>{
  const app=bootstrap();app.click('new');const html=app.elements.overlay.innerHTML;
  for(const name of ['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira'])assert.ok(html.includes(name));
  assert.match(html,/<select name="consultant"><option value="">Não informado/);
  assert.match(html,/name="amount" inputmode="decimal"/);
  assert.match(html,/name="funding_source" required/);
  assert.match(html,/id="bank-field" hidden/);
  assert.match(html,/name="bank_name"[^>]* disabled/);
});

test('local save parses BRL, persists finance fields, requests notifications once and exports them safely',async()=>{
  const app=bootstrap();await app.submit(validFields());
  assert.equal(app.writes.at(-1).invoices.length,1);
  const saved=app.writes.at(-1).invoices[0];assert.equal(saved.amount_cents,123456);assert.equal(saved.consultant,'Raimundo Sergio');assert.equal(saved.funding_source,'bank');assert.equal(saved.bank_name,'Banco do Brasil');assert.equal(saved.amount,undefined);
  assert.equal(app.permissionRequests,1);
  await app.submit({...validFields(),nf_number:'124',funding_source:'own',bank_name:'Ignored old bank'});
  assert.equal(app.permissionRequests,1);assert.equal(app.writes.at(-1).invoices[1].bank_name,'');
  app.navigate('invoices');assert.match(app.elements.main.innerHTML,/Raimundo Sergio/);assert.match(app.elements.main.innerHTML,/1\.234,56/);assert.match(app.elements.main.innerHTML,/Banco do Brasil/);assert.match(app.elements.main.innerHTML,/Recursos próprios/);
  app.click('export-csv');app.click('export-backup');const csv=app.files[0].content,backup=JSON.parse(app.files[1].content);
  assert.match(csv,/"Consultor";"Valor \(R\$\)";"Origem dos recursos";"Banco"/);assert.match(csv,/"Raimundo Sergio";"1\.234,56";"Banco";"Banco do Brasil"/);assert.equal(backup.version,2);assert.equal(backup.invoices[0].amount_cents,123456);assert.equal(backup.cloud,undefined);
});

test('required finance fields reject partial data and do not write any invoice',async()=>{
  for(const overrides of [{amount:'0,00'},{amount:'abc'},{funding_source:''},{bank_name:''}]){
    const app=bootstrap();await app.submit({...validFields(),...overrides});assert.equal(app.writes.length,0,JSON.stringify(overrides));assert.equal(app.permissionRequests,0);assert.equal(app.elements['form-error'].hidden,false);
  }
});

test('legacy notes remain visible with unavailable fields and require completing finance data on edit',async()=>{
  const old=invoice(),app=bootstrap({raw:JSON.stringify({invoices:[old],events:[],mode:'local'})});
  assert.doesNotMatch(app.elements.main.innerHTML,/Vamos recuperar seu espaço/);assert.match(app.elements.main.innerHTML,/nota antiga sem valor informado/);
  app.navigate('invoices');assert.match(app.elements.main.innerHTML,/Não informado/);assert.match(app.elements.main.innerHTML,/Valor não informado/);
  app.click('edit',{id:old.id});assert.match(app.elements.overlay.innerHTML,/value="" required/);
  await app.submit({...validFields(),consultant:'',amount:''},{id:old.id,version:'1'});assert.equal(app.writes.length,0);
  await app.submit(validFields(),{id:old.id,version:'1'});assert.equal(app.writes.at(-1).invoices[0].amount_cents,123456);assert.equal(app.writes.at(-1).invoices[0].id,old.id);
});

test('consultant filter and search select matching invoices independently of status filters',()=>{
  const rows=[invoice({consultant:'Fabio Araujo',amount_cents:100,funding_source:'own',bank_name:''}),invoice({id:'22222222-2222-4222-8222-222222222222',client_name:'Cliente Segundo',consultant:'Thiago Nogueira',amount_cents:200,funding_source:'bank',bank_name:'Itaú'})];
  const app=bootstrap({raw:JSON.stringify({invoices:rows,events:[]})});app.navigate('invoices');
  app.listeners.change({target:{id:'consultant-filter',value:'Thiago Nogueira'}});assert.match(app.elements.main.innerHTML,/Cliente Segundo/);assert.doesNotMatch(app.elements.main.innerHTML,/<div class="row-title">Cliente Aurora/);
  app.listeners.change({target:{id:'consultant-filter',value:''}});
  app.elements['invoice-search']={focus(){},setSelectionRange(){}};
  app.listeners.input({target:{id:'invoice-search',value:'fabio',selectionStart:5,selectionEnd:5}});assert.match(app.elements.main.innerHTML,/Cliente Aurora/);assert.doesNotMatch(app.elements.main.innerHTML,/<div class="row-title">Cliente Segundo/);
});

test('bank field visibility, requirement and clearing follow funding selection',()=>{
  const app=bootstrap(),input={value:'Banco anterior'},bank=app.elements['bank-field']={hidden:true,querySelector(){return input;}},form={id:'invoice-form'};
  app.listeners.change({target:{name:'funding_source',value:'bank',form}});assert.equal(bank.hidden,false);assert.equal(input.required,true);assert.equal(input.disabled,false);
  app.listeners.change({target:{name:'funding_source',value:'own',form}});assert.equal(bank.hidden,true);assert.equal(input.required,false);assert.equal(input.disabled,true);assert.equal(input.value,'');
});

test('due preview stays valid before the required consultant and finance fields are entered',()=>{
  const app=bootstrap();app.click('new');app.listeners.input({target:{name:'term_days',form:{id:'invoice-form',values:{billing_date:'2026-01-01',term_days:'5',consultant:'',amount:'',funding_source:''}}}});assert.match(app.elements['due-preview'].textContent,/6 de janeiro de 2026/);
});

test('settings has same-account sync, daily schedule and no group creation or invitations',()=>{
  const app=bootstrap();app.navigate('settings');const html=app.elements.main.innerHTML;
  assert.match(html,/Sincronizar meus celulares/);assert.match(html,/mesma conta/);assert.match(html,/Resumo diário às 9h/);assert.match(html,/todas as notas ainda não pagas/);assert.match(html,/<details[^>]*advanced-sync/);assert.doesNotMatch(html,/equipe|grupo|convite|create-team|join-team|workspace-entry/i);
});

test('automatic account sync notifies an unpaid-to-paid transition before replacing native cache once',async()=>{
  const local=invoice({consultant:'Rogerio Luiz',amount_cents:5000,funding_source:'own',bank_name:''});let current={...local};let ensured=0;
  const accountId='33333333-3333-4333-8333-333333333333';
  class Cloud{async ensureAccount(){ensured++;return {id:accountId,name:'Private'};}async listInvoices(){return [{...current}];}async listEvents(){return [];}async listConsultants(){return [];}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();} }
  const raw=JSON.stringify({mode:'cloud',invoices:[local],events:[],cloud:{url:'https://project.supabase.co',key:'public',session:{user:{email:'same@example.com'}},workspaceId:accountId,workspaces:[]}});
  const app=bootstrap({raw,Cloud});await flush();assert.equal(ensured,1);assert.equal(app.notifications.length,0);
  current={...current,paid_at:'2026-10-29T12:00:00Z',version:2};await app.windowListeners.focus();
  assert.equal(app.notifications.length,1);assert.equal(JSON.parse(app.notifications[0].cache)[0].paid_at,null);assert.ok(JSON.parse(app.caches.at(-1))[0].paid_at);assert.equal(app.notifications[0].client,'Cliente Aurora');
  await app.windowListeners.focus();assert.equal(app.notifications.length,1);app.navigate('settings');assert.doesNotMatch(app.elements.main.innerHTML,/equipe|grupo|convite/i);
});


test('stage3 local import persists only valid rows, creates consultants and records totals without source bytes',async()=>{
  const app=spreadsheetApp();app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'notas.xlsx',size:100,arrayBuffer:async()=>new ArrayBuffer(5)}]}});await flush();const w=app.workers[0];w.onmessage({data:{id:w.message.id,ok:true,table:sheetTable}});
  app.click('commit-import');await flush();const saved=app.writes.at(-1);assert.equal(saved.schemaVersion,2);assert.equal(saved.invoices.length,1);assert.equal(saved.invoices[0].nf_number,'0005');assert.equal(saved.invoices[0].funding_source,'unspecified');assert.equal(saved.invoices[0].consultant_phone,undefined);
  const c=saved.consultants.find(c=>c.name==='Ana Nova');assert.equal(c.phone,'+5571999991234');assert.equal(saved.invoices[0].consultant_id,c.id);assert.equal(c.whatsapp_authorized,false);assert.equal(saved.imports[0].imported_count,1);assert.equal(saved.imports[0].duplicate_count,1);assert.equal(saved.imports[0].error_count,1);assert.equal(saved.imports[0].file_name,'notas.xlsx');assert.equal(saved.imports[0].bytes,undefined);assert.match(app.elements.main.innerHTML,/1 importadas/);
});
test('stage3 consultant records are dynamic, normalized, version guarded and link invoice edits',async()=>{
  const app=bootstrap();app.click('consultants');assert.match(app.elements.main.innerHTML,/Consultores/);app.click('new-consultant');
  await app.submitForm('consultant-form',{name:'Ana Silva',phone:'(71) 99999-1234',email:'ana@example.com',active:'on',notifications_enabled:'on',whatsapp_authorized:'on'});let saved=app.writes.at(-1);const c=saved.consultants.find(c=>c.name==='Ana Silva');assert.equal(c.phone,'+5571999991234');assert.equal(c.whatsapp_authorized,true);assert.equal(c.version,1);
  await app.submit({...validFields(),consultant:'Ana Silva'});saved=app.writes.at(-1);assert.equal(saved.invoices[0].consultant_id,c.id);app.click('edit-consultant',{id:c.id});assert.match(app.elements.overlay.innerHTML,/Ana Silva/);
  const count=app.writes.length;await app.submitForm('consultant-form',{name:'Changed',phone:'',email:''},{id:c.id,version:'0'});assert.equal(app.writes.length,count);assert.match(app.elements['form-error'].textContent,/alterada|alterado/);
});
test('stage3 cloud sync failure preserves cached consultants imports notifications and native context',async()=>{
  const accountId='33333333-3333-4333-8333-333333333333',consultants=[{...core.seedConsultants()[0],name:'Consultor em cache'}];
  class Cloud{async ensureAccount(){return {id:accountId};}async listInvoices(){return [];}async listEvents(){return [];}async listConsultants(){throw Error('Falha de rede');}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();}}
  const app=bootstrap({raw:JSON.stringify({mode:'cloud',invoices:[],events:[],consultants,imports:[{id:'old-import'}],notifications:[{id:'old-notification'}],cloud:{url:'https://project.supabase.co',key:'public',session:{user:{id:'user'}},workspaceId:accountId,workspaces:[]}}),Cloud});await flush();const saved=app.writes.at(-1);assert.equal(saved.consultants[0].name,'Consultor em cache');assert.equal(saved.imports.length,1);assert.equal(saved.notifications.length,1);assert.equal(app.contexts.at(-1).consultants[0].name,'Consultor em cache');
});


test('stage3 failed local import rolls back invoices consultants events and batch history',async()=>{
  const app=spreadsheetApp({writeError:true});app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'notas.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}]}});await flush();const w=app.workers[0];w.onmessage({data:{id:w.message.id,ok:true,table:sheetTable}});app.click('commit-import');await flush();assert.equal(app.writes.length,0);assert.match(app.elements.main.innerHTML,/Não foi possível salvar/);app.navigate('invoices');assert.doesNotMatch(app.elements.main.innerHTML,/Cliente Importado/);app.click('consultants');assert.doesNotMatch(app.elements.main.innerHTML,/Ana Nova/);app.click('imports');assert.match(app.elements.main.innerHTML,/Nenhuma importação ainda/);
});
test('stage3 cloud retry keeps the same batch and generated row ids after an ambiguous timeout',async()=>{
  const accountId='33333333-3333-4333-8333-333333333333',payloads=[];
  class Cloud{async ensureAccount(){return {id:accountId};}async listInvoices(){return [];}async listEvents(){return [];}async listConsultants(){return [];}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();}async importInvoices(_,payload){payloads.push(JSON.stringify(payload));if(payloads.length===1)throw Error('Tempo esgotado');const stamp=new Date().toISOString();return {import:{id:payload.id,file_name:payload.file_name,total_count:3,imported_count:1,duplicate_count:1,error_count:1,ignored_count:0,status:'partial',created_at:stamp},imported:payload.rows.map(r=>({...r,created_at:stamp,updated_at:stamp,version:1})),duplicates:[],consultants:[]};}}
  const app=spreadsheetApp({Cloud,raw:JSON.stringify({mode:'cloud',invoices:[],events:[],cloud:{url:'https://project.supabase.co',key:'public',session:{user:{id:'user'}},workspaceId:accountId,workspaces:[]}})});await flush();app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[{name:'notas.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}]}});await flush();const w=app.workers[0];w.onmessage({data:{id:w.message.id,ok:true,table:sheetTable}});app.click('commit-import');await flush();assert.match(app.elements.main.innerHTML,/mesmo lote/);app.click('commit-import');await flush();assert.equal(payloads.length,2);assert.equal(payloads[0],payloads[1]);assert.ok(JSON.parse(payloads[0]).rows[0].id);assert.equal(app.writes.at(-1).invoices.length,1);
});


test('stage4 dashboard excludes cancelled balances and supports client period and six-status filters',()=>{
  const d=core.today(),row=(id,name,status,amount)=>invoice({id,client_name:name,billing_date:status==='overdue'?'2025-12-31':d,term_days:status==='near'||status==='overdue'?1:0,due_date:status==='overdue'?'2026-01-01':null,amount_cents:amount,consultant:'Rogerio Luiz',funding_source:'own',bank_name:'',paid_at:status==='paid'?new Date().toISOString():null,cancelled_at:status==='cancelled'?new Date().toISOString():null});
  const rows=[row('11111111-1111-4111-8111-111111111111','Hoje','today',10000),row('22222222-2222-4222-8222-222222222222','Atraso','overdue',20000),row('33333333-3333-4333-8333-333333333333','Cancelada','cancelled',90000),row('44444444-4444-4444-8444-444444444444','Perto','near',5000)];const app=bootstrap({raw:JSON.stringify({invoices:rows,events:[]})});assert.match(app.elements.main.innerHTML,/Valor vencido/);assert.match(app.elements.main.innerHTML,/350,00/);assert.match(app.elements.main.innerHTML,/Vencendo hoje/);app.navigate('invoices');app.listeners.change({target:{id:'status-filter',value:'cancelled'}});assert.match(app.elements.main.innerHTML,/Cancelada/);assert.doesNotMatch(app.elements.main.innerHTML,/NF 123[\s\S]*Hoje/);app.listeners.change({target:{id:'status-filter',value:'all'}});app.listeners.change({target:{id:'client-filter',value:'Perto'}});assert.match(app.elements.main.innerHTML,/Perto/);assert.doesNotMatch(app.elements.main.innerHTML,/class="row-title">Atraso/);app.listeners.change({target:{id:'client-filter',value:''}});app.listeners.change({target:{id:'date-to-filter',value:'2026-01-02'}});assert.match(app.elements.main.innerHTML,/class="row-title">Atraso/);assert.doesNotMatch(app.elements.main.innerHTML,/class="row-title">Perto/);
});
test('stage4 cancelling and reopening notes uses version guards and creates history',async()=>{
  const inv=invoice({amount_cents:1000,consultant:'Rogerio Luiz',funding_source:'own',bank_name:''}),app=bootstrap({raw:JSON.stringify({invoices:[inv],events:[]})});app.click('cancel',{id:inv.id});assert.match(app.elements.overlay.innerHTML,/Cancelar esta nota/);app.click('confirm-cancel',{id:inv.id,version:'1'});await flush();assert.ok(app.writes.at(-1).invoices[0].cancelled_at);assert.equal(app.writes.at(-1).events.at(-1).action,'cancelled');app.click('confirm-uncancel',{id:inv.id,version:'1'});await flush();assert.equal(app.writes.at(-1).invoices[0].version,2);app.click('uncancel',{id:inv.id});app.click('confirm-uncancel',{id:inv.id,version:'2'});await flush();assert.equal(app.writes.at(-1).invoices[0].cancelled_at,null);
});
test('stage4 central counts only user-confirmed WhatsApp notices and stores configurable billing rules',async()=>{
  const c=core.seedConsultants()[0],inv=invoice({consultant_id:c.id,consultant:c.name,amount_cents:1000,funding_source:'own',bank_name:''});const notes=[{id:'prepared',invoice_id:inv.id,status:'prepared',channel:'whatsapp_manual',created_at:new Date().toISOString()},{id:'local',invoice_id:inv.id,status:'shown',channel:'local',created_at:new Date().toISOString()}];const app=bootstrap({raw:JSON.stringify({invoices:[inv],events:[],consultants:[c],notifications:notes})});app.click('collections');assert.match(app.elements.main.innerHTML,/Central de Cobranças/);assert.match(app.elements.main.innerHTML,/data-metric="notified"[^>]*>0/);assert.match(app.elements.main.innerHTML,/Em aberto/);const confirmed=bootstrap({raw:JSON.stringify({invoices:[inv],events:[],consultants:[c],notifications:[...notes,{id:'confirmed',invoice_id:inv.id,channel:'whatsapp_manual',status:'confirmed_by_user',created_at:new Date().toISOString()}]})});confirmed.click('collections');assert.match(confirmed.elements.main.innerHTML,/data-metric="notified"[^>]*>1/);await app.submitForm('billing-rules-form',{before_days:'2',on_due:'on',after_days:'4',repeat_days:'5',hour:'10',daily_summary:'on'});const saved=app.writes.at(-1);assert.equal(saved.settings.billingRules.before_days,2);assert.equal(saved.settings.billingRules.hour,10);assert.equal(app.contexts.at(-1).billingRules.repeat_days,5);
});


test('stage4 editing imported issue date or term recalculates inherited explicit due date',async()=>{
  const inv=invoice({billing_date:'2026-11-03',term_days:5,due_date:'2026-11-08',consultant:'Rogerio Luiz',amount_cents:1000,funding_source:'own',bank_name:''}),app=bootstrap({raw:JSON.stringify({invoices:[inv],events:[]})});await app.submit({...validFields(),billing_date:'2026-11-03',term_days:'10',consultant:'Rogerio Luiz',funding_source:'own',bank_name:''},{id:inv.id,version:'1'});const updated=app.writes.at(-1).invoices[0];assert.equal(core.dueDate(updated),'2026-11-13');assert.equal(updated.due_date,null);
});


test('stage4 version2 backup restores local Android log and version1 backup migrates only after confirmation',async()=>{
  const c=core.seedConsultants()[0],inv=invoice({consultant:c.name,consultant_id:c.id,amount_cents:1000,funding_source:'own',bank_name:''}),local={id:'55555555-5555-4555-8555-555555555555',invoice_id:inv.id,consultant_id:null,channel:'local',status:'shown',kind:'due',created_at:new Date().toISOString()};
  const app=bootstrap({raw:JSON.stringify({invoices:[inv],events:[],consultants:[c]}),localLog:[local]});app.click('export-backup');const v2=JSON.parse(app.files[0].content);assert.equal(v2.notifications[0].channel,'local');
  for(const backup of [v2,{app:'NotaFlow',version:1,invoices:[{...inv,consultant_id:null}],events:[],settings:{defaultTerm:8}}]){const fresh=bootstrap();fresh.listeners.change({target:{id:'import-file',files:[{size:100,text:async()=>JSON.stringify(backup)}]}});await flush();assert.equal(fresh.writes.length,0);assert.ok(fresh.elements.overlay,fresh.elements['form-error']?.textContent);assert.match(fresh.elements.overlay.innerHTML,/Substituir seus dados locais/);fresh.elements['restore-confirm'].handlers.click();assert.equal(fresh.writes.at(-1).schemaVersion,2);assert.equal(fresh.writes.at(-1).invoices[0].client_name,inv.client_name);if(backup.version===2)assert.equal(fresh.writes.at(-1).notifications[0].status,'shown');}
});


function manualApp({consultant={},invoice:invoiceChanges={},...options}={}){const c={...core.seedConsultants()[0],phone:'+5571999991234',...consultant},inv=invoice({consultant_id:c.id,consultant:c.name,amount_cents:123456,funding_source:'own',bank_name:'',...invoiceChanges});return {...bootstrap({raw:JSON.stringify({invoices:[inv],events:[],consultants:[c]}),...options}),consultant:c,invoice:inv};}
test('stage5 WhatsApp composer creates prepared record and only explicit confirmation marks the invoice advised',async()=>{
  const app=manualApp();app.navigate('invoices');assert.match(app.elements.main.innerHTML,/data-action="whatsapp"/);app.click('whatsapp',{id:app.invoice.id});await flush();assert.equal(app.composers.length,1);assert.equal(app.composers[0].phone,app.consultant.phone);assert.match(app.composers[0].message,/Cliente Aurora/);let saved=app.writes.at(-1),notice=saved.notifications[0];assert.equal(notice.status,'prepared');assert.equal(notice.confirmed_at,null);assert.match(app.elements.overlay.innerHTML,/Confirmar que enviei/);app.click('whatsapp',{id:app.invoice.id});await flush();assert.equal(app.composers.length,1);assert.equal(app.writes.at(-1).notifications.length,1);app.click('notification-confirm',{id:notice.id});await flush();saved=app.writes.at(-1);assert.equal(saved.notifications[0].status,'confirmed_by_user');assert.ok(saved.notifications[0].confirmed_at);app.click('collections');assert.match(app.elements.main.innerHTML,/data-metric="notified"[^>]*>1/);assert.doesNotMatch(JSON.stringify(saved.notifications),/"status":"sent"/);
});
test('stage5 missing phones open registered consultant editor and paid cancelled inactive or disabled contacts cannot open composer',async()=>{
  const missing=manualApp({consultant:{phone:''}});missing.click('whatsapp',{id:missing.invoice.id});await flush();assert.equal(missing.composers.length,0);assert.equal(missing.writes.length,0);assert.match(missing.elements.overlay.innerHTML,/consultant-form/);
  for(const options of [{consultant:{active:false}},{consultant:{notifications_enabled:false}},{invoice:{paid_at:new Date().toISOString()}},{invoice:{cancelled_at:new Date().toISOString()}}]){const app=manualApp(options);app.click('whatsapp',{id:app.invoice.id});await flush();assert.equal(app.composers.length,0);assert.equal(app.writes.length,0);}
});
test('stage5 failure to open WhatsApp records a failed attempt without confirmation',async()=>{
  const app=manualApp({whatsappResult:false});app.click('whatsapp',{id:app.invoice.id});await flush();assert.equal(app.writes.at(-1).notifications[0].status,'failed');assert.doesNotMatch(app.elements.overlay.innerHTML,/Confirmar que enviei/);assert.match(app.elements.overlay.innerHTML,/Não foi possível abrir/);
});
test('stage5 cloud record retry uses the same contact snapshot and never reopens the composer',async()=>{
  const accountId='33333333-3333-4333-8333-333333333333',c={...core.seedConsultants()[0],phone:'+5571999991234'},inv=invoice({consultant_id:c.id,consultant:c.name,amount_cents:100,funding_source:'own',bank_name:''}),records=[];
  class Cloud{async ensureAccount(){return {id:accountId};}async listInvoices(){return [inv];}async listEvents(){return [];}async listConsultants(){return [c];}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();}async recordNotification(record){records.push(JSON.stringify(record));if(records.length===1)throw Error('Rede indisponível');return record;}}
  const app=bootstrap({Cloud,raw:JSON.stringify({mode:'cloud',invoices:[inv],events:[],consultants:[c],cloud:{url:'https://project.supabase.co',key:'public',session:{user:{id:'user'}},workspaceId:accountId,workspaces:[]}})});await flush();app.click('whatsapp',{id:inv.id});await flush();assert.equal(app.composers.length,1);assert.match(app.elements.overlay.innerHTML,/Registro não salvo/);const notice=JSON.parse(records[0]);app.click('notification-retry',{id:notice.id});await flush();assert.equal(records.length,2);assert.equal(records[0],records[1]);assert.equal(app.composers.length,1);assert.equal(app.writes.at(-1).notifications[0].status,'prepared');
});


test('account switch during billing save cannot overwrite local billing rules',async()=>{
  const accountId='33333333-3333-4333-8333-333333333333';let complete;
  class Cloud{async ensureAccount(){return {id:accountId};}async listInvoices(){return [];}async listEvents(){return [];}async listConsultants(){return [];}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();}saveBillingSettings(){return new Promise(resolve=>complete=resolve);}}
  const app=bootstrap({Cloud,raw:JSON.stringify({mode:'cloud',invoices:[],events:[],localData:{invoices:[],events:[],billingRules:core.normalizeRules({before_days:7})},cloud:{url:'https://project.supabase.co',key:'public',session:{user:{id:'user'}},workspaceId:accountId,workspaces:[]}})});await flush();await app.submitForm('billing-rules-form',{before_days:'2',after_days:'4',repeat_days:'3',hour:'9',on_due:'on',daily_summary:'on'});app.click('local');await flush();complete();await flush();assert.equal(app.writes.at(-1).mode,'local');assert.equal(app.writes.at(-1).settings.billingRules.before_days,7);
});
test('switching account after an import timeout clears only the previous pending UI batch',async()=>{
  const accountId='33333333-3333-4333-8333-333333333333';class Cloud{async ensureAccount(){return {id:accountId};}async listInvoices(){return [];}async listEvents(){return [];}async listConsultants(){return [];}async listImports(){return [];}async listNotifications(){return [];}async getBillingSettings(){return core.normalizeRules();}async importInvoices(){throw Error('Tempo esgotado');}}
  const app=spreadsheetApp({Cloud,raw:JSON.stringify({mode:'cloud',invoices:[],events:[],cloud:{url:'https://project.supabase.co',key:'public',session:{user:{id:'user'}},workspaceId:accountId,workspaces:[]}})});await flush();const file={name:'notas.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(1)};app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[file]}});await flush();const w=app.workers[0];w.onmessage({data:{id:w.message.id,ok:true,table:sheetTable}});app.click('commit-import');await flush();app.click('local');await flush();app.click('spreadsheet');app.listeners.change({target:{id:'spreadsheet-file',files:[file]}});await flush();assert.equal(app.workers.length,2);assert.equal(app.workers[1].message.filename,'notas.csv');
});
