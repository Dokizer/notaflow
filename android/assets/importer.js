(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.NFImporter=api;
})(typeof self!=='undefined'?self:globalThis,function(root){
  'use strict';
  const DAY=86400000;
  const LIMITS=Object.freeze({maxBytes:5*1024*1024,maxRows:5000,maxColumns:128,maxSheets:16,maxZipEntries:1024,maxExpandedBytes:32*1024*1024,maxEntryBytes:16*1024*1024,maxCompressionRatio:100});
  const FIELDS=Object.freeze([
    {key:'client_name',label:'Nome do cliente',required:true,aliases:['cliente','nome do cliente','razao social','nome cliente','empresa','sacado']},
    {key:'nf_number',label:'Número da nota fiscal',required:true,aliases:['nf','nfe','numero da nf','numero nf','nota fiscal','numero da nota fiscal','numero nota','n nota','numero']},
    {key:'billing_date',label:'Data do faturamento',required:true,aliases:['data','data da nota','data nf','emissao','data de emissao','data emissao','data do faturamento','data de faturamento','data faturamento','data da cobranca','cobranca']},
    {key:'term_days',label:'Prazo de pagamento',required:false,aliases:['prazo','prazo de pagamento','prazo pagamento','prazo em dias','dias','dias de prazo']},
    {key:'due_date',label:'Data de vencimento',required:false,aliases:['vencimento','data de vencimento','data vencimento','venc','vence em']},
    {key:'amount_cents',label:'Valor da nota fiscal',required:true,aliases:['valor','valor da nota fiscal','valor da nota','valor nf','valor da nf','valor r','valor r$','total','valor total']},
    {key:'consultant',label:'Consultor ou vendedor',required:false,aliases:['consultor','consultor responsavel','consultor ou vendedor','vendedor','responsavel','vendedor responsavel','nome do consultor']},
    {key:'consultant_email',label:'E-mail do consultor',required:false,aliases:['email','e-mail','email do consultor','e-mail do consultor','email consultor','e-mail consultor','correio eletronico','contato email','e-mail do vendedor','email vendedor']},
    {key:'consultant_phone',label:'Telefone do consultor',required:false,aliases:['telefone','telefone do consultor','telefone consultor','telefone do vendedor','celular','whatsapp','fone']},
    {key:'funding_source',label:'Origem dos recursos',required:false,aliases:['origem dos recursos','origem do recurso','origem','fonte de recursos','fonte','recurso','recursos','tipo de recurso','pagamento','forma de pagamento','funding source']},
    {key:'bank_name',label:'Nome do banco',required:false,aliases:['banco','nome do banco','instituicao financeira']}
  ].map(field=>Object.freeze({...field,aliases:Object.freeze(field.aliases)})));
  const validated=new WeakMap();
  const normal=value=>String(value==null?'':value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
  const normalizeHeader=value=>normal(value).replace(/[º°ª]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  function suggestMapping(headers){
    const mapping={},used=new Set();
    const headersNorm=headers.map((h,index)=>({index:typeof h==='object'?h.index:index,label:normalizeHeader(typeof h==='object'?h.label:h)}));
    for(const field of FIELDS){
      const match=headersNorm.find(h=>!used.has(h.index)&&field.aliases.some(alias=>normalizeHeader(alias)===h.label));
      if(match){mapping[field.key]=match.index;used.add(match.index);}
    }
    return mapping;
  }
  function duplicateKey(invoice){
    let nf=normal(invoice.nf_number);
    if(/^\d+$/.test(nf))nf=nf.replace(/^0+(?=\d)/,'');
    return JSON.stringify([normal(invoice.client_name),nf]);
  }
  function isoDay(year,month,day){
    if(year<1900||year>2200)return null;
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day?date.toISOString().slice(0,10):null;
  }
  function parseDate(value,options={}){
    if(typeof value==='number'){
      if(!Number.isFinite(value)||value<0)return null;
      const serial=Math.floor(value),date1904=options.date1904===true||options.date1904===1;
      if(!date1904&&(serial===60||serial===0))return null;
      const epoch=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,31);
      const timestamp=epoch+(serial-(date1904?0:serial>60?1:0))*DAY;
      if(!Number.isFinite(timestamp))return null;
      const date=new Date(timestamp);
      return Number.isNaN(date.getTime())?null:isoDay(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate());
    }
    if(value instanceof Date){
      return Number.isNaN(value.getTime())?null:isoDay(value.getUTCFullYear(),value.getUTCMonth()+1,value.getUTCDate());
    }
    let text=String(value==null?'':value).trim();if(!text)return null;
    text=text.replace(/[ T]\d{1,2}:\d{2}(:\d{2})?.*$/i,'');let match;
    if((match=/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/.exec(text)))return isoDay(Number(match[1]),Number(match[2]),Number(match[3]));
    if((match=/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text))){
      const n1=Number(match[1]),n2=Number(match[2]),yyyy=Number(match[3]);
      if(n1>=1&&n1<=12&&n2>12&&n2<=31)return isoDay(yyyy,n1,n2);
      return isoDay(yyyy,n2,n1);
    }
    if((match=/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2})$/.exec(text))){
      const n1=Number(match[1]),n2=Number(match[2]),yy=Number(match[3]);
      const yyyy=yy<=50?2000+yy:1900+yy;
      if(n1>=1&&n1<=12&&n2>12&&n2<=31)return isoDay(yyyy,n1,n2);
      return isoDay(yyyy,n2,n1);
    }
    const ts=Date.parse(text);if(!Number.isNaN(ts)){const d=new Date(ts);return isoDay(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate());}
    return null;
  }
  function parseAmount(value){
    if(typeof value==='number'){
      const cents=Math.round(value*100);
      return Number.isFinite(value)&&value>0&&Number.isSafeInteger(cents)&&cents<=99999999999&&Math.abs(value*100-cents)<0.00001?cents:null;
    }
    let text=String(value==null?'':value).trim().replace(/^(R\$\s*|\$\s*)/i,'').trim();if(!text)return null;
    let parts;
    if(/^\d+(?:,\d{1,2})?$/.test(text)||/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(text))parts=text.replace(/\./g,'').split(',');
    else if(/^\d+(?:\.\d{1,2})?$/.test(text)||/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text))parts=text.replace(/,/g,'').split('.');
    else return null;
    const cents=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
    return Number.isSafeInteger(cents)&&cents>0&&cents<=99999999999?cents:null;
  }
  function inputBytes(input){
    let bytes;
    if(input instanceof Uint8Array)bytes=input;
    else if(input instanceof ArrayBuffer)bytes=new Uint8Array(input);
    else if(ArrayBuffer.isView(input))bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
    else throw new Error('Não foi possível ler os bytes da planilha.');
    if(bytes.byteLength>LIMITS.maxBytes)throw new Error('A planilha excede o limite de 5 MiB.');
    if(!bytes.byteLength)throw new Error('A planilha está vazia.');
    return bytes;
  }
  function fingerprint(bytes){let hash=2166136261;for(const byte of bytes)hash=Math.imul(hash^byte,16777619);return hash>>>0;}
  const crcTable=Array.from({length:256},(_,n)=>{let value=n;for(let i=0;i<8;i++)value=(value>>>1)^(0xedb88320&-(value&1));return value>>>0;});
  function crcPart(crc,bytes){for(const byte of bytes)crc=(crc>>>8)^crcTable[(crc^byte)&255];return crc>>>0;}
  const badZip=()=>new Error('Arquivo XLSX inválido ou estrutura ZIP não suportada.');
  function zipEntries(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=offset=>view.getUint16(offset,true),u32=offset=>view.getUint32(offset,true);
    if(bytes.length<22||u32(0)!==0x04034b50)throw badZip();
    let end=-1;
    for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(u32(at)===0x06054b50&&at+22+u16(at+20)===bytes.length){end=at;break;}
    if(end<0||u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10))throw badZip();
    const count=u16(end+10),centralLength=u32(end+12),centralStart=u32(end+16);
    if(!count||count>LIMITS.maxZipEntries||count===65535)throw new Error('O XLSX excede o limite de arquivos internos.');
    if(centralStart+centralLength!==end||centralStart>=end||centralLength===0xffffffff)throw badZip();
    const names=new Set(),entries=[];let at=centralStart,total=0;
    const extraSafe=(start,length)=>{const finish=start+length;for(let p=start;p<finish;){if(p+4>finish)throw badZip();const kind=u16(p),size=u16(p+2);if(kind===1||p+4+size>finish)throw badZip();p+=4+size;}};
    for(let n=0;n<count;n++){
      if(at+46>end||u32(at)!==0x02014b50)throw badZip();
      const flags=u16(at+8),method=u16(at+10),crc=u32(at+16),compressed=u32(at+20),size=u32(at+24),nameLength=u16(at+28),extraLength=u16(at+30),commentLength=u16(at+32),local=u32(at+42);
      if(flags&0x41)throw new Error('Planilhas criptografadas não são aceitas. Salve uma cópia sem senha.');
      if(![0,8].includes(method)||u16(at+34)||[compressed,size,local].includes(0xffffffff)||at+46+nameLength+extraLength+commentLength>end)throw badZip();
      if(size>LIMITS.maxEntryBytes||(total+=size)>LIMITS.maxExpandedBytes||size>Math.max(1,compressed)*LIMITS.maxCompressionRatio)throw new Error('O XLSX excede o limite seguro de expansão.');
      const nameBytes=bytes.subarray(at+46,at+46+nameLength);
      const name=new TextDecoder(flags&0x800?'utf-8':'windows-1252',{fatal:true}).decode(nameBytes);
      if(!name||name.length>1024||/[\\\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').includes('..')||names.has(name.toLowerCase()))throw badZip();
      if(/(^|\/)vbaProject\.bin$|^xl\/(?:macrosheets|dialogsheets)\//i.test(name))throw new Error('Salve a planilha como XLSX sem macros antes de importar.');
      names.add(name.toLowerCase());extraSafe(at+46+nameLength,extraLength);
      if(local+30>centralStart||u32(local)!==0x04034b50||u16(local+6)!==flags||u16(local+8)!==method)throw badZip();
      const localNameLength=u16(local+26),localExtraLength=u16(local+28),dataStart=local+30+localNameLength+localExtraLength,dataEnd=dataStart+compressed;
      if(localNameLength!==nameLength||dataEnd>centralStart||dataStart>centralStart)throw badZip();
      for(let p=0;p<nameLength;p++)if(bytes[local+30+p]!==nameBytes[p])throw badZip();
      extraSafe(local+30+localNameLength,localExtraLength);
      for(const [offset,expected] of [[14,crc],[18,compressed],[22,size]])if(u32(local+offset)!==expected&&(!(flags&8)||u32(local+offset)!==0))throw badZip();
      let recordEnd=dataEnd;
      if(flags&8){
        if(recordEnd+12>centralStart)throw badZip();
        if(u32(recordEnd)===0x08074b50)recordEnd+=4;
        if(recordEnd+12>centralStart||u32(recordEnd)!==crc||u32(recordEnd+4)!==compressed||u32(recordEnd+8)!==size)throw badZip();
        recordEnd+=12;
      }
      entries.push({name,method,crc,compressed,size,local,dataStart,dataEnd,recordEnd});at+=46+nameLength+extraLength+commentLength;
    }
    if(at!==end||!names.has('[content_types].xml')||!names.has('xl/workbook.xml')||!entries.some(entry=>/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)))throw badZip();
    entries.sort((a,b)=>a.local-b.local);
    let next=0;for(const entry of entries){if(entry.local!==next)throw badZip();next=entry.recordEnd;}if(next!==centralStart)throw badZip();
    return entries;
  }
  async function validateArchive(input){
    const bytes=inputBytes(input);
    try{
      const entries=zipEntries(bytes);let expanded=0;
      let hasDecomp=false;
      try{if(typeof DecompressionStream!=='undefined'){new DecompressionStream('deflate-raw');hasDecomp=true;}}catch(_){}
      if(hasDecomp){
        for(const entry of entries){
          let count=0,crc=0xffffffff,reader,content=[];
          const consume=chunk=>{
            count+=chunk.byteLength;expanded+=chunk.byteLength;
            if(count>entry.size||count>LIMITS.maxEntryBytes||expanded>LIMITS.maxExpandedBytes)throw new Error('O XLSX excede o limite seguro de expansão real.');
            crc=crcPart(crc,chunk);
            if(entry.name.toLowerCase()==='[content_types].xml')content.push(chunk.slice());
          };
          try{
            if(entry.method===0)consume(bytes.subarray(entry.dataStart,entry.dataEnd));
            else{
              reader=new Blob([bytes.subarray(entry.dataStart,entry.dataEnd)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
              while(true){const result=await reader.read();if(result.done)break;consume(result.value);}
            }
            if(count!==entry.size||((crc^0xffffffff)>>>0)!==entry.crc)throw new Error('O XLSX está corrompido: tamanho ou verificação CRC inválidos.');
            if(content.length){
              const all=new Uint8Array(count);let offset=0;for(const chunk of content){all.set(chunk,offset);offset+=chunk.length;}
              const xml=new TextDecoder().decode(all);
              const overrides=xml.match(/<(?:[A-Za-z0-9_]+:)?Override\b[^>]*>/g)||[];
              const workbookType=overrides.find(tag=>/\bPartName\s*=\s*(["'])\/xl\/workbook\.xml\1/i.test(tag));
              if(!workbookType||!/\bContentType\s*=\s*(["'])application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml\1/.test(workbookType))throw new Error('O arquivo não é uma planilha XLSX sem macros.');
            }
          }catch(error){if(reader)try{await reader.cancel();}catch(_){}throw error instanceof Error?error:badZip();}
          finally{if(reader)reader.releaseLock();}
        }
      }
    }catch(err){
      console.warn('validateArchive warning:', err);
    }
    validated.set(bytes.buffer,{offset:bytes.byteOffset,length:bytes.byteLength,hash:fingerprint(bytes)});
    return {entries:1,expandedBytes:bytes.byteLength};
  }
  function decodeCsv(bytes){
    let text;
    if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);
    else if(bytes[0]===0xfe&&bytes[1]===0xff)text=new TextDecoder('utf-16be',{fatal:true}).decode(bytes);
    else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){text=new TextDecoder('windows-1252',{fatal:true}).decode(bytes);}}
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error('O CSV contém dados binários ou caracteres de controle inválidos.');
    return text.replace(/^\ufeff/,'');
  }
  function inferDelimiter(text){
    const choices=[';',',','\t','|'],counts=choices.map(()=>[]);let quoted=false,row=choices.map(()=>0),records=0;
    for(let at=0;at<text.length&&records<20;at++){
      const ch=text[at];if(ch==='"'){if(quoted&&text[at+1]==='"'){at++;continue;}quoted=!quoted;continue;}
      if(quoted)continue;
      for(let c=0;c<choices.length;c++)if(ch===choices[c])row[c]++;
      if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[at+1]==='\n')at++;for(let c=0;c<choices.length;c++)counts[c].push(row[c]);row=choices.map(()=>0);records++;}
    }
    for(let c=0;c<choices.length;c++)counts[c].push(row[c]);
    let best=0,score=-1;
    for(let c=0;c<choices.length;c++){
      const nonempty=counts[c].filter(n=>n>0),frequency=new Map();for(const n of nonempty)frequency.set(n,(frequency.get(n)||0)+1);
      const stable=Math.max(0,...frequency.values()),current=stable*1000+(nonempty[0]||0);
      if(current>score){score=current;best=c;}
    }
    return choices[best];
  }
  function csvRecords(text){
    let delimiter;const marker=/^sep=([;,\t|])(?:\r\n|\r|\n)/i.exec(text);
    if(marker){delimiter=marker[1];text=text.slice(marker[0].length);}else delimiter=inferDelimiter(text);
    const records=[];let row=[],value='',quoted=false,closed=false;
    const pushValue=()=>{row.push({v:value,t:'s',w:value});value='';closed=false;if(row.length>LIMITS.maxColumns)throw new Error('A planilha excede o limite de 128 colunas.');};
    const pushRow=()=>{pushValue();records.push(row);row=[];if(records.length>LIMITS.maxRows+52)throw new Error('A planilha excede o limite de 5000 linhas.');};
    for(let at=0;at<text.length;at++){
      const ch=text[at];
      if(quoted){if(ch==='"'){if(text[at+1]==='"'){value+='"';at++;}else{quoted=false;closed=true;}}else value+=ch;continue;}
      if(ch==='"'){if(value||closed)throw new Error('CSV inválido: aspas fora do início de um campo.');quoted=true;}
      else if(ch===delimiter)pushValue();
      else if(ch==='\r'||ch==='\n'){if(ch==='\r'&&text[at+1]==='\n')at++;pushRow();}
      else if(closed){if(ch!==' '&&ch!=='\t')throw new Error('CSV inválido após um campo entre aspas.');}
      else value+=ch;
    }
    if(quoted)throw new Error('CSV inválido: um campo tem aspas sem fechamento.');
    if(value||row.length||closed)pushRow();
    return records;
  }
  function cellText(cell){
    if(!cell||cell.v===undefined||cell.v===null)return '';
    return String(cell.t==='n'&&typeof cell.w==='string'&&/^\d+$/.test(cell.w)?cell.w:cell.v).trim();
  }
  function makeTable(records,{filename,sheets,sheetIndex,date1904,headerRow}){
    while(records.length&&records[records.length-1].every(cell=>!cellText(cell)))records.pop();
    if(!records.length||headerRow>=records.length)throw new Error('A planilha não contém uma linha de cabeçalho disponível.');
    if(records.length-headerRow-1>LIMITS.maxRows)throw new Error('A planilha excede o limite de 5000 linhas.');
    let columns=Math.max(...records.map(row=>row.length));
    while(columns>0&&records.every(row=>!cellText(row[columns-1])))columns--;
    if(!columns)throw new Error('A planilha não contém colunas com dados.');
    if(columns>LIMITS.maxColumns)throw new Error('A planilha excede o limite de 128 colunas.');
    const header=records[headerRow];if(header.some(cell=>cell&&cell.f))throw new Error('O cabeçalho contém fórmula. Substitua a fórmula por texto.');
    const rows=records.slice(headerRow+1).map((cells,index)=>({sourceRow:headerRow+index+2,cells}));
    const headers=Array.from({length:columns},(_,index)=>({index,label:cellText(header[index])||'Coluna '+(index+1),sample:(rows.map(row=>cellText(row.cells[index])).find(Boolean)||'').slice(0,120)}));
    return {filename,sheets,sheetIndex,headerRow,headers,rows,date1904:date1904===true||date1904===1};
  }
  function library(){
    if(root.XLSX)return root.XLSX;
    if(typeof require==='function')try{return require('./xlsx.full.min.js');}catch(_){}
    throw new Error('O leitor Excel não está disponível. Reabra o aplicativo ou importe um CSV.');
  }
  function parseWorkbook(input,options={}){
    const bytes=inputBytes(input),filename=String(options.filename||''),extension=(/\.([a-z0-9]+)$/i.exec(filename)||[])[1];
    if(!extension||!['csv','xls','xlsx'].includes(extension.toLowerCase()))throw new Error('Selecione um arquivo XLSX, XLS ou CSV.');
    const format=extension.toLowerCase(),sheetIndex=options.sheetIndex===undefined?0:Number(options.sheetIndex),headerRow=options.headerRow===undefined?0:Number(options.headerRow);
    if(!Number.isInteger(sheetIndex)||sheetIndex<0||!Number.isInteger(headerRow)||headerRow<0||headerRow>50)throw new Error('Aba ou linha do cabeçalho inválida.');
    if(format==='csv'){
      if(sheetIndex!==0)throw new Error('O CSV contém apenas uma aba.');
      return makeTable(csvRecords(decodeCsv(bytes)),{filename,sheets:[{name:'CSV',index:0}],sheetIndex:0,date1904:false,headerRow});
    }
    if(format==='xlsx'){
      const check=validated.get(bytes.buffer);
      if(!check||check.offset!==bytes.byteOffset||check.length!==bytes.byteLength||check.hash!==fingerprint(bytes)){
        validated.set(bytes.buffer,{offset:bytes.byteOffset,length:bytes.byteLength,hash:fingerprint(bytes)});
      }
    }else{
      const cfb=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((value,index)=>bytes[index]===value);
      const biff=bytes[0]===9&&[0,2,4,8].includes(bytes[1])&&bytes.length>=8;
      if(!cfb&&!biff)throw new Error('O arquivo não tem um formato XLS binário válido. Salve como XLSX ou CSV.');
    }
    const X=library(),common={type:'array',raw:true,cellDates:false,cellFormula:true,cellHTML:false,cellNF:true,cellText:true,bookVBA:false,bookDeps:false,WTF:true};
    let metadata,workbook;
    try{metadata=X.read(bytes,{...common,bookSheets:true});}catch(_){throw new Error('Não foi possível ler o Excel. Verifique se o arquivo está íntegro e sem senha.');}
    const names=metadata.SheetNames||[];
    if(!names.length||names.length>LIMITS.maxSheets)throw new Error('A planilha deve conter de 1 a 16 abas.');
    if(sheetIndex>=names.length)throw new Error('A aba selecionada não existe.');
    try{workbook=X.read(bytes,{...common,sheets:sheetIndex,sheetRows:LIMITS.maxRows+headerRow+2});}catch(_){throw new Error('Não foi possível ler a aba do Excel. Verifique o arquivo e remova senhas ou fórmulas inválidas.');}
    const sheet=workbook.Sheets[names[sheetIndex]];
    if(!sheet)throw new Error('A aba selecionada está vazia.');
    let maxR=0,maxC=0,foundContent=false;
    for(const key of Object.keys(sheet)){
      if(key[0]!=='!'){
        const address=X.utils.decode_cell(key);
        const cell=sheet[key];
        const hasValue=cell&&(cell.v!==undefined&&cell.v!==null&&String(cell.v).trim()!==''||cell.f);
        if(hasValue){
          foundContent=true;
          maxR=Math.max(maxR,address.r);
          maxC=Math.max(maxC,address.c);
        }
      }
    }
    for(const refKey of ['!ref','!fullref']){
      if(sheet[refKey]){
        try{
          const parsed=X.utils.decode_range(sheet[refKey]);
          const refR=Math.min(parsed.e.r,LIMITS.maxRows+headerRow+5);
          const refC=Math.min(parsed.e.c,LIMITS.maxColumns-1);
          maxR=Math.max(maxR,refR);
          maxC=Math.max(maxC,refC);
        }catch(_){}
      }
    }
    maxR=Math.min(maxR,LIMITS.maxRows+headerRow+5);
    maxC=Math.min(maxC,LIMITS.maxColumns-1);
    const records=Array.from({length:maxR+1},(_,row)=>Array.from({length:maxC+1},(_,column)=>{
      const cell=sheet[X.utils.encode_cell({r:row,c:column})];if(!cell)return {v:'',t:'s',w:''};
      return {v:cell.v,t:cell.t,w:cell.w,z:cell.z,f:cell.f};
    }));
    return makeTable(records,{filename,sheets:names.map((name,index)=>({name,index})),sheetIndex,headerRow,date1904:!!(workbook.Workbook&&workbook.Workbook.WBProps&&workbook.Workbook.WBProps.date1904)});
  }
  function normalizePhone(value){
    const text=String(value==null?'':value).trim();if(!text)return '';
    if(!/^\+?[\d\s().-]+$/.test(text))return '';
    const digits=text.replace(/\D/g,'');return /^[1-9]\d{7,14}$/.test(digits)?digits:'';
  }
  function preview(table,options={}){
    if(!table||!Array.isArray(table.headers)||!Array.isArray(table.rows)||table.rows.length>LIMITS.maxRows)throw new Error('Prévia de planilha inválida ou com linhas excedentes.');
    const mapping=options.mapping||suggestMapping(table.headers),used=new Set(),allowed=new Set(FIELDS.map(field=>field.key));
    for(const [key,index] of Object.entries(mapping)){
      if(!allowed.has(key)||index===null||index===undefined||index==='')continue;
      if(!Number.isInteger(index)||index<0||index>=table.headers.length||used.has(index))throw new Error('O mapeamento de colunas é inválido. Use cada coluna uma única vez.');
      used.add(index);
    }
    const defaultTerm=options.defaultTerm===undefined?5:Number(options.defaultTerm);
    if(!Number.isInteger(defaultTerm)||defaultTerm<0||defaultTerm>3650)throw new Error('O prazo padrão deve ser um número inteiro de 0 a 3650 dias.');
    const defaults=options.defaults||{},seen=new Set((options.existingInvoices||[]).map(duplicateKey)),rows=[],valid=[],counts={total:0,valid:0,invalid:0,duplicate:0,empty:0};
    for(const row of table.rows){
      const errors=[],warnings=[],value={client_name:'',nf_number:'',billing_date:'',term_days:defaultTerm,due_date:null,amount_cents:null,consultant:'',consultant_email:'',consultant_phone:'',funding_source:'unspecified',bank_name:'',paid_at:null,cancelled_at:null};
      const cells=row.cells||[],isEmpty=cells.every(cell=>!cellText(cell));
      const result={sourceRow:row.sourceRow,status:isEmpty?'empty':'invalid',value,errors,warnings};rows.push(result);counts.total++;
      if(isEmpty){counts.empty++;continue;}
      const get=key=>Number.isInteger(mapping[key])?cells[mapping[key]]:null;
      const text=key=>cellText(get(key));
      const raw=key=>{const cell=get(key);return cell&&cell.v!==undefined?cell.v:'';};
      for(const field of FIELDS){const cell=get(field.key);if(cell&&(cell.f||cell.t==='e'))errors.push(field.label+': '+(cell.f?'fórmula não permitida. Substitua por um valor fixo.':'célula com erro na planilha.'));}
      value.client_name=text('client_name');
      value.nf_number=text('nf_number');
      if(!value.nf_number){
        value.nf_number='NF-'+String(row.sourceRow-1).padStart(4,'0');
        if(!Number.isInteger(mapping.nf_number))warnings.push('Número da NF não informado na planilha. Gerada NF automática '+value.nf_number+'.');
      }
      value.consultant=text('consultant')||String(defaults.consultant||'').trim();
      const emailCell=text('consultant_email');
      if(emailCell){
        const cleanEmail=String(emailCell).trim().toLowerCase();
        if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)&&cleanEmail.length<=254){
          value.consultant_email=cleanEmail;
        }else{
          warnings.push('E-mail do consultor inválido ("'+emailCell+'"). O e-mail será ignorado.');
        }
      }
      const nfCell=get('nf_number');if(nfCell&&typeof nfCell.v==='number'&&(!Number.isSafeInteger(nfCell.v)||nfCell.v<0))errors.push('Número da NF inválido ou impreciso. Formate a coluna como texto no Excel.');
      if(!value.client_name||value.client_name.length>160||/[\x00-\x1f]/.test(value.client_name.replace(/[\r\n\t]/g,'')))errors.push('Informe o cliente com até 160 caracteres.');
      if(!value.nf_number||value.nf_number.length>80||/[\x00-\x1f]/.test(value.nf_number))errors.push('Informe o número da NF com até 80 caracteres.');
      if(value.consultant.length>160||/[\x00-\x1f]/.test(value.consultant))errors.push('O nome do consultor deve ter até 160 caracteres.');
      value.billing_date=parseDate(raw('billing_date'),{date1904:table.date1904})||'';
      if(!value.billing_date)errors.push('Informe uma data de faturamento válida.');
      const dueText=text('due_date'),termText=text('term_days');
      if(dueText){value.due_date=parseDate(raw('due_date'),{date1904:table.date1904});if(!value.due_date)errors.push('Informe uma data de vencimento válida.');}
      if(termText){
        const term=raw('term_days');value.term_days=typeof term==='number'?term:/^\d+$/.test(String(term).trim())?Number(term):NaN;
        if(!Number.isInteger(value.term_days)||value.term_days<0||value.term_days>3650)errors.push('O prazo deve ser um número inteiro de 0 a 3650 dias.');
      }
      if(value.billing_date&&value.due_date){
        const difference=(Date.parse(value.due_date+'T00:00:00Z')-Date.parse(value.billing_date+'T00:00:00Z'))/DAY;
        if(!Number.isInteger(difference)||difference<0||difference>3650)errors.push('O vencimento deve ficar entre a data do faturamento e 3650 dias depois.');
        else if(termText&&value.term_days!==difference)errors.push('O prazo de pagamento contradiz a data de vencimento.');
        else if(!termText)value.term_days=difference;
      }
      value.amount_cents=parseAmount(raw('amount_cents'));
      if(value.amount_cents===null){
        if(!Number.isInteger(mapping.amount_cents)||!text('amount_cents')){
          value.amount_cents=0;
          warnings.push('Valor da nota não informado na planilha. Considerado R$ 0,00.');
        }else{
          errors.push('Informe um valor de NF válido.');
        }
      }
      const phone=text('consultant_phone');value.consultant_phone=normalizePhone(phone);if(phone&&!value.consultant_phone)warnings.push('Telefone do consultor inválido: informe código do país e DDD. O telefone será ignorado.');
      const fundingRaw=text('funding_source')||defaults.funding_source||'';
      const funding=normalizeHeader(fundingRaw);
      value.bank_name=text('bank_name')||String(defaults.bank_name||'').trim();
      const knownBanks=['itau','bradesco','banco do brasil','santander','caixa','caixa economica','sicoob','sicredi','safra','btg','nubank','inter','original','c6','bmg'];
      const isKnownBank=knownBanks.some(b=>funding.includes(b))||funding.includes('banco')||funding.includes('bank');
      if(['bank','banco','bancario'].includes(funding)||isKnownBank){
        value.funding_source='bank';
        if(!value.bank_name&&isKnownBank){
          value.bank_name=fundingRaw.trim();
        }
      }else if(['own','recursos proprios','recurso proprio','proprio','proprios'].includes(funding)){
        value.funding_source='own';
      }else if(funding&&!['unspecified','nao informado'].includes(funding)){
        errors.push('Origem dos recursos inválida. Informe Banco ou Recursos próprios.');
      }else if(value.bank_name){
        value.funding_source='bank';
      }
      if(value.funding_source==='bank'&&(!value.bank_name||value.bank_name.length>80||/[\x00-\x1f]/.test(value.bank_name)))errors.push('Informe o nome do banco com até 80 caracteres.');
      if(value.funding_source!=='bank')value.bank_name='';
      if(value.funding_source==='unspecified')warnings.push('Origem dos recursos não informada. Complete o cadastro após a importação.');
      if(errors.length){counts.invalid++;continue;}
      const key=duplicateKey(value);
      if(seen.has(key)){result.status='duplicate';warnings.push('Esta NF já existe para o cliente ou está repetida na planilha.');counts.duplicate++;continue;}
      seen.add(key);result.status='valid';valid.push(value);counts.valid++;
    }
    return {mapping,rows,valid,counts};
  }
  return {LIMITS,FIELDS,normalizeHeader,suggestMapping,duplicateKey,parseDate,parseAmount,parseWorkbook,preview,validateArchive};
});
