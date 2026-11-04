const test=require('node:test'),assert=require('node:assert/strict'),C=require('../android/assets/core.js');
const invoice=(extra={})=>({id:'n1',client_name:'Cliente A',nf_number:'000123',billing_date:'2026-11-01',term_days:5,consultant:'Consultor novo',amount_cents:12345,funding_source:'own',bank_name:'',paid_at:null,cancelled_at:null,...extra});
test('vencimento explícito não é confundido com faturamento e canceladas não cobram',()=>{
 assert.equal(C.dueDate(invoice({due_date:'2026-11-10'})),'2026-11-10');
 assert.equal(C.detailedStatus(invoice(),'2026-11-04'),'current');assert.equal(C.detailedStatus(invoice(),'2026-11-05'),'near');assert.equal(C.detailedStatus(invoice(),'2026-11-06'),'due_today');assert.equal(C.detailedStatus(invoice(),'2026-11-07'),'overdue');
 assert.equal(C.detailedStatus(invoice({paid_at:'2026-11-07T12:00:00Z'}),'2026-11-08'),'paid');
 const cancelled=invoice({cancelled_at:'2026-11-07T12:00:00Z'});assert.equal(C.status(cancelled,'2026-11-08'),'cancelled');assert.equal(C.collectionTrigger(cancelled,'2026-11-08'),null);
 assert.equal(C.validateInvoice(invoice({due_date:'2026-10-30'})).ok,false);
 assert.equal(C.validateInvoice(invoice({due_date:'2026-11-07'})).ok,false);
 assert.equal(C.validateInvoice(invoice({due_date:'2026-11-06'})).ok,true);
});
test('agenda dispara antes, hoje, após um dia e repete a cada três',()=>{
 const row=invoice();for(const [date,kind] of [['2026-11-05','before'],['2026-11-06','due'],['2026-11-07','overdue'],['2026-11-10','overdue'],['2026-11-13','overdue']])assert.equal(C.collectionTrigger(row,date).kind,kind,date);
 for(const date of ['2026-11-04','2026-11-08','2026-11-09'])assert.equal(C.collectionTrigger(row,date),null,date);
 assert.equal(C.collectionTrigger(invoice({paid_at:'2026-11-05T00:00:00Z'}),'2026-11-07'),null);
 assert.equal(C.collectionTrigger(row,'2026-11-08',{after_days:2,repeat_days:0}).kind,'overdue');assert.equal(C.collectionTrigger(row,'2026-11-11',{after_days:2,repeat_days:0}),null);
 assert.equal(C.collectionTrigger(row,'2026-11-06',{on_due:false}),null);
 assert.throws(()=>C.normalizeRules({repeat_days:-1}));
});
test('consultores dinâmicos e telefone internacional são validados sem inventar contato',()=>{
 const c=C.validateConsultant({name:'Maria Nova',phone:'(71) 99999-8888',email:'maria@example.com'});assert.equal(c.ok,true);assert.equal(c.value.phone,'+5571999998888');assert.equal(c.value.active,true);
 assert.equal(C.validateConsultant({name:'Sem telefone',phone:''}).ok,true);
 assert.equal(C.validateConsultant({name:'X',phone:'123'}).ok,false);assert.equal(C.validateConsultant({name:'X',email:'invalido'}).ok,false);
 assert.equal(C.validateInvoice(invoice({consultant:''})).ok,true);
 assert.equal(C.validateInvoice(invoice({funding_source:'unspecified'}),{allowUnspecifiedFunding:true}).ok,true);
 assert.equal(C.validateInvoice(invoice({funding_source:'unspecified'})).ok,false);
});
test('mensagem WhatsApp mantém dados corretos e URL segura; abrir não representa envio',()=>{
 const consultant={id:'c1',name:'Maria Nova',phone:'+5571999998888',active:true,notifications_enabled:true};
 const message=C.whatsappMessage(invoice(),consultant,'2026-11-09');assert.match(message,/NF|Nota fiscal/);assert.match(message,/000123/);assert.match(message,/123,45/);assert.match(message,/06\/11\/2026/);assert.match(message,/3/);
 const url=new URL(C.whatsappUrl(consultant.phone,message));assert.equal(url.origin,'https://wa.me');assert.equal(url.pathname,'/5571999998888');assert.equal(url.searchParams.get('text'),message);
 assert.equal(C.canWhatsApp(invoice(),{...consultant,phone:''}).ok,false);assert.equal(C.canWhatsApp(invoice({cancelled_at:'2026-11-03T00:00:00Z'}),consultant).ok,false);assert.equal(C.canWhatsApp(invoice(),{...consultant,notifications_enabled:false}).ok,false);
 assert.throws(()=>C.whatsappUrl('https://evil.test','x'));
});
test('migração local mantém IDs, histórico, valores e separação dos dados locais',()=>{
 const old={invoices:[invoice({consultant:'Raimundo Sergio'})],events:[{id:'ev1'}],settings:{defaultTerm:8},mode:'local',localData:{invoices:[invoice({id:'other'})],events:[]}};
 const migrated=C.upgradeState(old);assert.equal(migrated.schemaVersion,2);assert.equal(migrated.invoices[0].id,'n1');assert.equal(migrated.invoices[0].amount_cents,12345);assert.equal(migrated.events[0].id,'ev1');assert.equal(migrated.settings.defaultTerm,8);assert.equal(migrated.consultants.length,5);assert.ok(migrated.invoices[0].consultant_id);assert.equal(migrated.localData.invoices[0].id,'other');
 const again=C.upgradeState(migrated);assert.deepEqual(again.consultants,migrated.consultants);assert.equal(old.schemaVersion,undefined);
});
test('chave de duplicação considera cliente e NF preservando zeros na exibição',()=>{
 assert.equal(C.duplicateKey(invoice()),C.duplicateKey(invoice({client_name:'  CLIÉNTE  A ',nf_number:'123'})));assert.notEqual(C.duplicateKey(invoice()),C.duplicateKey(invoice({client_name:'Cliente B'})));assert.equal(invoice().nf_number,'000123');
});
