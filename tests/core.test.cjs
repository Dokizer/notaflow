const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../android/assets/core.js');
const nf=(extra={})=>({id:'test',client_name:'Mercado São João',nf_number:'00123',billing_date:'2026-10-29',term_days:5,paid_at:null,consultant:'Raimundo Sergio',amount_cents:123456,funding_source:'bank',bank_name:'Banco do Brasil',...extra});
test('prazo padrão cruza mês e preserva número de NF',()=>{
 const result=C.validateInvoice(nf({term_days:undefined}));
 assert.equal(result.ok,true); assert.equal(result.value.term_days,5);
 assert.equal(C.dueDate(result.value),'2026-11-03'); assert.equal(result.value.nf_number,'00123');
});
test('dias corridos respeitam ano bissexto e prazo zero',()=>{
 assert.equal(C.dueDate(nf({billing_date:'2024-02-28',term_days:2})),'2024-03-01');
 assert.equal(C.dueDate(nf({billing_date:'2026-12-31',term_days:1})),'2027-01-01');
 assert.equal(C.dueDate(nf({term_days:0})),'2026-10-29');
});
test('vencimento hoje fica pendente; amanhã e atraso são dias inteiros',()=>{
 assert.equal(C.status(nf(),'2026-11-03'),'pending');
 assert.equal(C.status(nf(),'2026-11-04'),'overdue');
 assert.equal(C.daysUntil(nf(),'2026-11-02'),1);
 assert.equal(C.daysUntil(nf(),'2026-11-04'),-1);
 assert.equal(C.status(nf({paid_at:'2026-10-30T15:00:00Z'}),'2026-11-04'),'paid');
});
test('datas impossíveis e prazos inválidos são rejeitados',()=>{
 for(const date of ['2026-02-29','2026-13-01','2026-01-32','29/10/2026','']) assert.equal(C.validateInvoice(nf({billing_date:date})).ok,false,date);
 for(const term of [-1,3651,1.5,'abc','']) assert.equal(C.validateInvoice(nf({term_days:term})).ok,false,String(term));
 assert.equal(C.validateInvoice(nf({client_name:'  '})).ok,false);
 assert.equal(C.validateInvoice(nf({nf_number:' '})).ok,false);
});
test('painel separa pendentes e atrasadas e ignora pagas nos alertas',()=>{
 const rows=[nf(),nf({id:'2',billing_date:'2026-10-20'}),nf({id:'3',paid_at:'2026-10-30T00:00:00Z'}),nf({id:'4',billing_date:'2026-10-28'})];
 assert.deepEqual(C.summary(rows,'2026-11-02'),{total:4,paid:1,pending:2,overdue:1,cancelled:0,dueTomorrow:1,dueToday:1});
});
test('busca aceita acentos e número de NF sem alterar dados',()=>{
 const rows=[nf(),nf({id:'2',client_name:'Loja Centro',nf_number:'991'})];
 assert.equal(C.filterInvoices(rows,'sao joao','all','2026-11-01')[0].id,'test');
 assert.equal(C.filterInvoices(rows,'00123','pending','2026-11-01').length,1);
 assert.equal(C.filterInvoices(rows,'','overdue','2026-11-04').length,2);
 assert.equal(C.filterInvoices(rows,'<script>','all','2026-11-01').length,0);
});
test('identificador gera UUID versão 4',()=>{
 const a=C.uuid(), b=C.uuid(); assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.notEqual(a,b);
});
test('valor da NF usa centavos exatos e aceita entrada brasileira',()=>{
 for(const [input,cents] of [['1.234,56',123456],['R$ 1.234,56',123456],['0,01',1],['100',10000],['100.50',10050],['1.234',123400],['10,1',1010]])assert.equal(C.parseMoney(input),cents,input);
 for(const value of ['1,234','-1,00','1e5','abc','1.23,45',''])assert.equal(C.parseMoney(value),null,value);
 assert.equal(C.formatMoney(123456).replace(/\u00a0/g,' '),'R$ 1.234,56');
});
test('cadastro preserva consultores iniciais e exige valor positivo e origem do recurso',()=>{
 assert.deepEqual(C.CONSULTANTS,['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira']);
 for(const consultant of C.CONSULTANTS)assert.equal(C.validateInvoice(nf({consultant})).ok,true);
 for(const patch of [{amount_cents:0},{amount_cents:1.5},{amount_cents:100000000000},{funding_source:''},{funding_source:'other'},{bank_name:''}])assert.equal(C.validateInvoice(nf(patch)).ok,false,JSON.stringify(patch));
 assert.equal(C.validateInvoice(nf({consultant:''})).ok,true);assert.equal(C.validateInvoice(nf({consultant:'Outro'})).ok,true);
 const own=C.validateInvoice(nf({funding_source:'own',bank_name:'Nome antigo'}));assert.equal(own.ok,true);assert.equal(own.value.bank_name,'');
});
test('notas antigas são preservadas na importação sem dispensar os campos de novas notas',()=>{
 const legacy={client_name:'Antigo',nf_number:'1',billing_date:'2026-10-29',term_days:5};
 assert.equal(C.validateInvoice(legacy).ok,false);
 assert.equal(C.validateInvoice(legacy,{allowLegacy:true}).ok,true);
 assert.equal(C.validateInvoice({...legacy,consultant:'Desconhecido'},{allowLegacy:true}).ok,false);
 assert.equal(C.filterInvoices([nf()],'raimundo','all','2026-11-01').length,1);
});
