const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {zip,minimalXlsxEntries}=require('./fixtures/importer-zip.cjs');
const X=require('../android/assets/xlsx.full.min.js');
const importerPath=path.join(__dirname,'../android/assets/importer.js');
let I;
try{I=require(importerPath);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const csv=(text,options={})=>I.parseWorkbook(new TextEncoder().encode(text),{filename:'notas.csv',...options});
const basic='Cliente;NF;Emissão;Prazo;Vencimento;Valor;Vendedor;Telefone\nMercado São João;000123;29/10/2026;;;1.234,56;Ana Silva;+55 (71) 99999-1234';
const preview=(text=basic,options={})=>{const table=csv(text);return I.preview(table,{mapping:I.suggestMapping(table.headers),...options});};

test('importer module is available as CommonJS API',()=>{
 assert.ok(I,'NFImporter has not been implemented');
 for(const name of ['parseWorkbook','preview','suggestMapping','duplicateKey','parseDate','parseAmount','validateArchive'])assert.equal(typeof I[name],'function',name);
});
test('column aliases recognize reordered Portuguese financial headers',()=>{
 const table=csv('Valor da nota;Razão Social;Número da NF;Data de faturamento;Prazo de pagamento;Data de vencimento;Consultor responsável;Telefone do consultor\n123,45;Cliente A;0001;2026-11-03;5;2026-11-08;Ana;5571999999999');
 assert.deepEqual(I.suggestMapping(table.headers),{amount_cents:0,client_name:1,nf_number:2,billing_date:3,term_days:4,due_date:5,consultant:6,consultant_phone:7});
 assert.equal(table.rows[0].sourceRow,2);
 assert.equal(I.preview(table,{mapping:I.suggestMapping(table.headers)}).counts.valid,1);
});
test('CSV preserves zeroes, BR currency and default term without inventing funding',()=>{
 const p=preview();assert.equal(p.counts.valid,1);const value=p.valid[0];
 assert.equal(value.nf_number,'000123');assert.equal(value.amount_cents,123456);assert.equal(value.billing_date,'2026-10-29');assert.equal(value.term_days,5);assert.equal(value.due_date,null);
 assert.equal(value.consultant,'Ana Silva');assert.equal(value.consultant_phone,'5571999991234');assert.equal(value.funding_source,'unspecified');assert.equal(value.bank_name,'');
 assert.ok(p.rows[0].warnings.some(w=>/recursos/i.test(w)));
});
test('CSV handles quoted separators, newlines, escaped quotes, BOM and Excel sep declaration',()=>{
 const table=csv('\ufeffsep=;\r\nCliente;NF;Emissão;Valor\r\n"Loja; \"\"Aurora\"\"\nCentro";0001;2026-11-03;10,00\r\n');
 assert.equal(table.headers[0].label,'Cliente');assert.equal(table.rows[0].cells[0].v,'Loja; "Aurora"\nCentro');assert.equal(table.rows.length,1);
 assert.equal(I.preview(table,{mapping:I.suggestMapping(table.headers)}).counts.valid,1);
 assert.throws(()=>csv('Cliente;NF\n"Texto sem fechar;1'),/aspas|CSV/i);
});
test('CSV decodes Windows1252 accent bytes only after strict UTF8 decoding fails',()=>{
 const bytes=Uint8Array.from(Buffer.from('Cliente;NF;Emiss\xe3o;Valor\nJo\xe3o;01;2026-11-03;1,00','latin1'));
 const table=I.parseWorkbook(bytes,{filename:'legado.csv'});assert.equal(table.headers[2].label,'Emissão');assert.equal(table.rows[0].cells[0].v,'João');
});
test('manual column mapping accepts index zero and rejects conflicting/out of range indexes',()=>{
 const table=csv('A;B;C;D\nCliente;0001;03/11/2026;10,50');
 assert.equal(I.preview(table,{mapping:{client_name:0,nf_number:1,billing_date:2,amount_cents:3}}).counts.valid,1);
 assert.throws(()=>I.preview(table,{mapping:{client_name:0,nf_number:0,billing_date:2,amount_cents:3}}),/coluna|mapeamento/i);
 assert.throws(()=>I.preview(table,{mapping:{client_name:9}}),/coluna|mapeamento/i);
});
test('strict dates cover BR ISO leap days and Excel 1900/1904 epochs without timezone shifts',()=>{
 for(const [input,expected] of [['03/11/2026','2026-11-03'],['2026-11-03','2026-11-03'],['29.02.2024','2024-02-29'],[1,'1900-01-01'],[59,'1900-02-28'],[61,'1900-03-01'],[46329,'2026-11-03']])assert.equal(I.parseDate(input),expected,String(input));
 assert.equal(I.parseDate(0,{date1904:true}),'1904-01-01');assert.equal(I.parseDate(1.5,{date1904:true}),'1904-01-02');
 for(const input of [60,'29/02/2026','2026-02-30','11/03/26','11/31/2026','2026-11-03T01:00:00Z',-1,Infinity])assert.equal(I.parseDate(input),null,String(input));
});
test('amount parsing uses numeric cents without formatted locale ambiguity and bounds unsafe values',()=>{
 for(const [value,cents] of [[1234.56,123456],['R$ 1.234,56',123456],['10.50',1050],['1.234',123400],['0,01',1]])assert.equal(I.parseAmount(value),cents,String(value));
 for(const value of ['',0,-1,1.234,NaN,Infinity,'1e6','1,234','9999999999,99'])assert.equal(I.parseAmount(value),null,String(value));
});
test('explicit zero term remains zero and missing term derives from explicit due date',()=>{
 let p=preview('Cliente;NF;Emissão;Prazo;Vencimento;Valor\nCliente;01;2026-11-03;0;2026-11-03;1,00');assert.equal(p.valid[0].term_days,0);
 p=preview('Cliente;NF;Emissão;Prazo;Vencimento;Valor\nCliente;01;2026-11-03;;2026-11-10;1,00',{defaultTerm:99});assert.equal(p.valid[0].term_days,7);
 p=preview('Cliente;NF;Emissão;Prazo;Vencimento;Valor\nCliente;01;2026-11-03;5;2026-11-10;1,00');assert.equal(p.counts.invalid,1);assert.match(p.rows[0].errors.join(' '),/prazo|vencimento/i);
 p=preview('Cliente;NF;Vencimento;Valor\nCliente;01;2026-11-10;1,00');assert.equal(p.counts.invalid,1);assert.match(p.rows[0].errors.join(' '),/faturamento/i);
});
test('invalid required fields do not enter valid output and absent consultant stays optional',()=>{
 const p=preview('Cliente;NF;Emissão;Valor;Telefone\nCliente;01;2026-11-03;1,00;123\n;02;2026-11-03;1,00;\nCliente;;31/02/2026;abc;');
 assert.deepEqual(p.counts,{total:3,valid:1,invalid:2,duplicate:0,empty:0});assert.equal(p.valid[0].consultant,'');assert.equal(p.valid[0].consultant_phone,'');assert.match(p.rows[0].warnings.join(' '),/telefone/i);
});
test('duplicate key normalizes client accents whitespace case and NF zeroes while preserving display',()=>{
 assert.equal(I.duplicateKey({client_name:'  João   SILVA ',nf_number:'000123'}),I.duplicateKey({client_name:'joao silva',nf_number:'123'}));
 assert.notEqual(I.duplicateKey({client_name:'Outra loja',nf_number:'123'}),I.duplicateKey({client_name:'joao silva',nf_number:'123'}));
 const p=preview('Cliente;NF;Emissão;Valor\nJoão Silva;000123;2026-11-03;10,00\nJOAO   SILVA;123;2026-11-03;20,00\nOutra loja;123;2026-11-03;30,00',{existingInvoices:[{client_name:'joao silva',nf_number:'123'}]});
 assert.equal(p.counts.duplicate,2);assert.equal(p.counts.valid,1);assert.equal(p.valid[0].client_name,'Outra loja');
 const batch=preview('Cliente;NF;Emissão;Valor\nJoão Silva;000123;2026-11-03;10,00\nJOAO SILVA;123;2026-11-03;20,00');assert.equal(batch.valid[0].nf_number,'000123');assert.equal(batch.counts.duplicate,1);
});
test('formula cells are rejected without executing cached values; hostile text remains data',()=>{
 const table=csv('Cliente;NF;Emissão;Valor\n<script>alert(1)</script>;01;2026-11-03;1,00');let p=I.preview(table,{mapping:I.suggestMapping(table.headers)});assert.equal(p.counts.valid,1);assert.match(p.valid[0].client_name,/<script>/);
 table.rows[0].cells[3]={t:'n',v:123,f:'WEBSERVICE("https://evil.example")'};p=I.preview(table,{mapping:I.suggestMapping(table.headers)});assert.equal(p.counts.invalid,1);assert.match(p.rows[0].errors.join(' '),/fórmula/i);
});
test('oversized files rows columns and binary masquerading as CSV fail instead of truncating',()=>{
 assert.throws(()=>I.parseWorkbook(new Uint8Array(I.LIMITS.maxBytes+1),{filename:'big.csv'}),/5|tamanho|MiB/i);
 assert.throws(()=>csv('Cliente;NF\n'+Array.from({length:I.LIMITS.maxRows+1},(_,i)=>'Cliente;'+i).join('\n')),/linhas/i);
 assert.throws(()=>csv(Array.from({length:I.LIMITS.maxColumns+1},(_,i)=>'col'+i).join(';')),/colunas/i);
 assert.throws(()=>I.parseWorkbook(Uint8Array.of(0,1,2,3,4),{filename:'renamed.csv'}),/CSV|binário|formato/i);
 assert.throws(()=>I.parseWorkbook(new TextEncoder().encode('<html><table></table></html>'),{filename:'renamed.xls'}),/XLS|formato/i);
});
const excel=(bookType='xlsx',{rows=[['Cliente','NF','Emissão','Valor'],['Loja','000123','2026-11-03',1234.56]],date1904=false,sheets=1,edit}={})=>{
 const book=X.utils.book_new();book.Workbook={WBProps:{date1904}};
 for(let n=0;n<sheets;n++){const sheet=X.utils.aoa_to_sheet(rows);if(edit)edit(sheet,n);X.utils.book_append_sheet(book,sheet,'Notas '+n);}
 return X.write(book,{type:'array',bookType,compression:true});
};
test('real XLSX and XLS fixtures preserve numeric NF display zeroes and raw monetary cents',async()=>{
 for(const bookType of ['xlsx','xls']){
  const bytes=excel(bookType,{rows:[['Cliente','NF','Emissão','Valor'],['Loja',123,46329,1234.56]],edit:sheet=>{sheet.B2.z='000000';sheet.C2.z='dd/mm/yyyy';}});
  if(bookType==='xlsx')await I.validateArchive(bytes);
  const table=I.parseWorkbook(bytes,{filename:'fixture.'+bookType}),p=I.preview(table,{});
  assert.equal(p.counts.valid,1,JSON.stringify(p.rows));assert.equal(p.valid[0].nf_number,'000123');assert.equal(p.valid[0].billing_date,'2026-11-03');assert.equal(p.valid[0].amount_cents,123456);
 }
});
test('workbook sheet/header selectors retain row numbers and 1904 date epoch',async()=>{
 const bytes=excel('xlsx',{rows:[['Relatório financeiro'],['NF','Valor','Cliente','Emissão'],['01',10,'Loja',1]],date1904:true,sheets:2});
 await I.validateArchive(bytes);const table=I.parseWorkbook(bytes,{filename:'fixture.xlsx',sheetIndex:1,headerRow:1}),p=I.preview(table,{});
 assert.equal(table.sheets.length,2);assert.equal(table.sheetIndex,1);assert.equal(table.rows[0].sourceRow,3);assert.equal(table.date1904,true);assert.equal(p.valid[0].billing_date,'1904-01-02');
});
test('Excel cached formulas and unsafe numeric NF cannot become imported invoices',async()=>{
 const bytes=excel('xlsx',{edit:sheet=>{sheet.B2={t:'n',v:12345678901234568};sheet.D2={t:'n',v:10,f:'1+9'};}});await I.validateArchive(bytes);
 const p=I.preview(I.parseWorkbook(bytes,{filename:'fixture.xlsx'}),{});assert.equal(p.counts.invalid,1);assert.match(p.rows[0].errors.join(' '),/fórmula/);assert.match(p.rows[0].errors.join(' '),/impreciso/);
});
test('real XLSX limits reject sheets and reported/actual ranges rather than silently truncating',async()=>{
 const many=excel('xlsx',{sheets:I.LIMITS.maxSheets+1});await I.validateArchive(many);assert.throws(()=>I.parseWorkbook(many,{filename:'many.xlsx'}),/16 abas/);
 for(const range of ['A1:D5002','A1:DY2']){
  const bytes=excel('xlsx',{edit:sheet=>{sheet['!ref']=range;}});await I.validateArchive(bytes);assert.throws(()=>I.parseWorkbook(bytes,{filename:'range.xlsx'}),/linhas|colunas/);
 }
});
test('a full 5000 invoice CSV imports while an extra real Excel row is refused',async()=>{
 const rows=Array.from({length:I.LIMITS.maxRows},(_,n)=>'Cliente '+n+';'+String(n).padStart(6,'0')+';03/11/2026;1,00');
 const p=preview('Cliente;NF;Emissão;Valor\n'+rows.join('\n'));assert.equal(p.counts.valid,5000);assert.equal(p.valid.at(-1).nf_number,'004999');
 const entries=minimalXlsxEntries([['Cliente','NF','Emissão','Valor'],...Array.from({length:I.LIMITS.maxRows+1},(_,n)=>['Cliente '+n,'NF'+n,'2026-11-03',n+1])]);
 entries[4].text=entries[4].text.replace('<sheetData>','<dimension ref="A1:D2"/><sheetData>');
 const bytes=zip(entries);await I.validateArchive(bytes);assert.throws(()=>I.parseWorkbook(bytes,{filename:'hidden-rows.xlsx'}),/linhas|colunas/);
});
test('XLSX preflight verifies real expanded bytes CRC and rejects security metadata tricks',async()=>{
 const good=zip(minimalXlsxEntries());const check=await I.validateArchive(good);assert.equal(check.entries,5);assert.ok(check.expandedBytes>0);assert.equal(I.parseWorkbook(good,{filename:'good.xlsx'}).rows[0].cells[1].v,'000123');
 const cases=[
  [zip(minimalXlsxEntries().map((entry,n)=>n===4?{...entry,declaredSize:1}:entry)),/expansão real|corrompido/],
  [zip(minimalXlsxEntries().map((entry,n)=>n===4?{...entry,declaredCrc:0}:entry)),/CRC/],
  [zip(minimalXlsxEntries().map((entry,n)=>n===4?{...entry,encrypted:true}:entry)),/criptografadas/],
  [zip(minimalXlsxEntries().map((entry,n)=>n===4?{...entry,method:12}:entry)),/ZIP/],
  [zip(minimalXlsxEntries(),{overlap:true}),/ZIP/],
  [zip(minimalXlsxEntries(),{diskNumber:1}),/ZIP/],
  [zip([...minimalXlsxEntries(),{name:'../evil.xml',text:'x'}]),/ZIP/],
  [zip([...minimalXlsxEntries(),{name:'xl/vbaProject.bin',text:'x'}]),/macros/],
  [zip([...minimalXlsxEntries(),{name:'xl/bomb.xml',text:'A'.repeat(100000),declaredSize:1}]),/expansão real|corrompido/],
  [zip([...minimalXlsxEntries(),{name:'xl/bomb.xml',text:'A'.repeat(100000)}]),/expansão/]
 ];
 for(const [bytes,error] of cases)await assert.rejects(I.validateArchive(bytes),error);
});
test('XLSX requires completed preflight and invalidates a preflight after bytes change',async()=>{
 const bytes=new Uint8Array(excel());assert.throws(()=>I.parseWorkbook(bytes,{filename:'fixture.xlsx'}),/Valide/);await I.validateArchive(bytes);bytes[31]^=1;assert.throws(()=>I.parseWorkbook(bytes,{filename:'fixture.xlsx'}),/Valide/);
});
test('browsers without bounded raw decompression reject XLSX with a useful update instruction',async()=>{
 const sandbox={Uint8Array,ArrayBuffer,DataView,TextDecoder,Blob,Set,Map,WeakMap,console};sandbox.self=sandbox;
 vm.runInNewContext(fs.readFileSync(importerPath,'utf8'),sandbox);
 await assert.rejects(sandbox.NFImporter.validateArchive(zip(minimalXlsxEntries())),/Atualize.*WebView/);
});
test('worker performs ZIP preflight before parsing and returns usable errors',async()=>{
 const messages=[],sandbox={Uint8Array,console,importScripts(){},NFImporter:I,postMessage(message){messages.push(message);}};sandbox.self=sandbox;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../android/assets/import-worker.js'),'utf8'),sandbox);
 await sandbox.onmessage({data:{id:1,bytes:new TextEncoder().encode(basic).buffer,filename:'notas.csv'}});
 assert.equal(messages[0].ok,true);assert.equal(messages[0].table.rows.length,1);
 await sandbox.onmessage({data:{id:2,bytes:Uint8Array.of(1,2,3).buffer,filename:'notas.xlsx'}});
 assert.equal(messages[1].id,2);assert.equal(messages[1].ok,false);assert.match(messages[1].error,/XLSX|ZIP/);
});
