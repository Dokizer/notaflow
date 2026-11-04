(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NFCore=api;})(typeof window!=='undefined'?window:globalThis,function(){
 const DAY=86400000;
 const CONSULTANTS=Object.freeze(['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira']);
 function parseMoney(input){
  const raw=String(input==null?'':input).trim().replace(/^R\$\s*/i,'');let parts;
  if(/^\d+(?:,\d{1,2})?$/.test(raw)||/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw))parts=raw.replace(/\./g,'').split(',');
  else if(/^\d+\.\d{1,2}$/.test(raw))parts=raw.split('.');else return null;
  const cents=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
  return Number.isSafeInteger(cents)&&cents<=99999999999?cents:null;
 }
 function formatMoney(cents){return Number.isSafeInteger(cents)&&cents>=0?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100):'Não informado';}
 function parseDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [y,m,d]=value.split('-').map(Number);
  if(y<1900||y>2200) return NaN;
  const n=Date.UTC(y,m-1,d),date=new Date(n);
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?n:NaN;
 }
 function today(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function dueDate(i){if(i.due_date)return Number.isFinite(parseDay(i.due_date))?i.due_date:'';const n=parseDay(i.billing_date),term=Number(i.term_days);if(!Number.isFinite(n)||!Number.isInteger(term)||term<0||term>3650)return '';return new Date(n+term*DAY).toISOString().slice(0,10);}
 function daysUntil(i,day=today()){return (parseDay(dueDate(i))-parseDay(day))/DAY;}
 function status(i,day=today()){return i.cancelled_at?'cancelled':i.paid_at?'paid':daysUntil(i,day)<0?'overdue':'pending';}
 function detailedStatus(i,day=today(),rules={}){const s=status(i,day);if(s!=='pending')return s;const d=daysUntil(i,day),r=normalizeRules(rules);return d===0?'due_today':r.before_days!==null&&d>0&&d<=r.before_days?'near':'current';}
 function validateInvoice(input,options={}){
  input=input||{};const value={...input,client_name:String(input.client_name||'').trim(),nf_number:String(input.nf_number||'').trim(),billing_date:input.billing_date,term_days:input.term_days===undefined?5:Number(input.term_days),paid_at:input.paid_at||null},errors=[];
  if(!value.client_name||value.client_name.length>160)errors.push('Informe o cliente com até 160 caracteres.');
  if(!value.nf_number||value.nf_number.length>80)errors.push('Informe o número da NF com até 80 caracteres.');
  if(!Number.isFinite(parseDay(value.billing_date)))errors.push('Informe uma data de faturamento válida.');
  if(input.term_days===''||!Number.isInteger(value.term_days)||value.term_days<0||value.term_days>3650)errors.push('O prazo deve ser um número inteiro de 0 a 3650 dias.');
  if(value.paid_at&&!Number.isFinite(Date.parse(value.paid_at)))errors.push('Data de pagamento inválida.');
  if(input.cancelled_at&&!Number.isFinite(Date.parse(input.cancelled_at)))errors.push('Data de cancelamento inválida.');
  if(input.cancelled_at&&value.paid_at)errors.push('Uma nota paga não pode estar cancelada.');
  if(input.due_date&&(!Number.isFinite(parseDay(input.due_date))||parseDay(input.due_date)<parseDay(value.billing_date)))errors.push('Informe um vencimento válido igual ou posterior ao faturamento.');
  if(input.due_date&&Number.isFinite(parseDay(input.due_date))&&Number.isFinite(parseDay(value.billing_date))&&Number.isInteger(value.term_days)&&parseDay(input.due_date)!==parseDay(value.billing_date)+value.term_days*DAY)errors.push('O vencimento informado não corresponde ao faturamento e ao prazo. Revise esses campos.');
  if(input.consultant_id&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.consultant_id))errors.push('Vínculo de consultor inválido.');
  const legacy=options.allowLegacy===true&&!['consultant','amount_cents','funding_source','bank_name'].some(k=>Object.prototype.hasOwnProperty.call(input,k));
  if(!legacy){
   value.consultant=String(input.consultant||'').trim();value.amount_cents=input.amount_cents;value.funding_source=input.funding_source;value.bank_name=input.funding_source==='own'?'':String(input.bank_name||'').trim();
   if(value.consultant.length>160||/[\u0000-\u001f\u007f]/.test(value.consultant))errors.push('Informe um nome de consultor válido, com até 160 caracteres.');
   if(!Number.isSafeInteger(value.amount_cents)||value.amount_cents<1||value.amount_cents>99999999999)errors.push('Informe um valor de NF válido, maior que zero.');
   if(!['bank','own'].includes(value.funding_source)&&!(value.funding_source==='unspecified'&&(options.allowUnspecifiedFunding||options.allowLegacy)))errors.push('Informe o banco ou selecione Recursos próprios.');
   if(value.funding_source==='bank'&&(!value.bank_name||value.bank_name.length>80))errors.push('Informe o nome do banco com até 80 caracteres.');
  }
  return {ok:errors.length===0,errors,value};
 }
 function summary(rows,day=today()){
  const out={total:rows.length,paid:0,pending:0,overdue:0,cancelled:0,dueTomorrow:0,dueToday:0};
  rows.forEach(i=>{const s=status(i,day);out[s]++;if(s!=='paid'&&s!=='cancelled'){const days=daysUntil(i,day);if(days===1)out.dueTomorrow++;if(days===0)out.dueToday++;}});return out;
 }
 const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 function duplicateKey(i){let nf=normalize(i.nf_number).trim().replace(/\s+/g,' ');if(/^\d+$/.test(nf))nf=nf.replace(/^0+(?=\d)/,'');return JSON.stringify([normalize(i.client_name).trim().replace(/\s+/g,' '),nf]);}
 function normalizePhone(value){let raw=String(value||'').trim();if(!raw)return '';if(/[^+\d\s().-]/.test(raw)||raw.slice(1).includes('+'))return null;let digits=raw.replace(/\D/g,'');if(!raw.startsWith('+')&&(digits.length===10||digits.length===11))digits='55'+digits;return /^[1-9]\d{7,14}$/.test(digits)?'+'+digits:null;}
 function validateConsultant(input){input=input||{};const value={...input,name:String(input.name||'').trim(),phone:normalizePhone(input.phone),email:String(input.email||'').trim(),active:input.active!==false,notifications_enabled:input.notifications_enabled!==false,whatsapp_authorized:input.whatsapp_authorized===true},errors=[];
  if(!value.name||value.name.length>160||/[\u0000-\u001f\u007f]/.test(value.name))errors.push('Informe o nome completo do consultor com até 160 caracteres.');
  if(value.phone===null)errors.push('Informe um telefone válido com DDD e código do país.');
  if(value.email&&(value.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)))errors.push('Informe um e-mail válido ou deixe em branco.');
  return {ok:errors.length===0,errors,value};
 }
 function normalizeRules(input={}){const r={before_days:1,on_due:true,after_days:1,repeat_days:3,hour:9,daily_summary:true,...input};for(const key of ['before_days','after_days']){if(r[key]===null||r[key]==='')r[key]=null;else{r[key]=Number(r[key]);if(!Number.isInteger(r[key])||r[key]<1||r[key]>3650)throw new Error('Os intervalos de cobrança devem ser de 1 a 3650 dias.');}}
  r.repeat_days=Number(r.repeat_days);r.hour=Number(r.hour);if(!Number.isInteger(r.repeat_days)||r.repeat_days<0||r.repeat_days>3650)throw new Error('A repetição deve ser de 0 a 3650 dias.');if(!Number.isInteger(r.hour)||r.hour<0||r.hour>23)throw new Error('Informe uma hora de 0 a 23.');r.on_due=r.on_due!==false;r.daily_summary=r.daily_summary!==false;return r;
 }
 function collectionTrigger(i,day=today(),rules={}){if(i.paid_at||i.cancelled_at)return null;const n=daysUntil(i,day),r=normalizeRules(rules);if(!Number.isFinite(n))return null;let kind=null;if(r.before_days!==null&&n===r.before_days)kind='before';else if(n===0&&r.on_due)kind='due';else if(r.after_days!==null&&n<0){const elapsed=-n-r.after_days;if(elapsed===0||elapsed>0&&r.repeat_days>0&&elapsed%r.repeat_days===0)kind='overdue';}return kind?{kind,occurrence:day}:null;}
 function canWhatsApp(i,c){if(i.paid_at||i.cancelled_at)return {ok:false,error:'Notas pagas ou canceladas não geram novas cobranças.'};if(!c)return {ok:false,error:'Vincule um consultor a esta nota.'};if(c.active===false)return {ok:false,error:'Este consultor está inativo.'};if(c.notifications_enabled===false)return {ok:false,error:'Os avisos deste consultor estão desativados.'};if(!normalizePhone(c.phone))return {ok:false,error:'Cadastre o telefone do consultor com DDD e código do país.'};return {ok:true,error:''};}
 function whatsappMessage(i,c,day=today()){const date=dueDate(i),label=date?date.split('-').reverse().join('/'):'Não informado',late=Math.max(0,-daysUntil(i,day));return 'Olá, '+c.name+'!\n\nO NotaFlow identificou uma pendência de pagamento.\n\nCliente: '+i.client_name+'\nNota fiscal: '+i.nf_number+'\nValor: '+formatMoney(i.amount_cents)+'\nVencimento: '+label+'\nDias em atraso: '+late+'\n\nPor favor, verifique a situação do pagamento e realize o acompanhamento necessário.';}
 function whatsappUrl(phone,message){const parsed=normalizePhone(phone);if(!parsed||!String(message)||String(message).length>6000)throw new Error('Telefone ou mensagem inválidos.');return 'https://wa.me/'+parsed.slice(1)+'?text='+encodeURIComponent(message);}
 function seedConsultants(){const now=new Date().toISOString();return CONSULTANTS.map(name=>({id:uuid(),name,phone:'',email:'',active:true,notifications_enabled:true,whatsapp_authorized:false,version:1,created_at:now,updated_at:now}));}
 function upgradeState(input){const state=JSON.parse(JSON.stringify(input||{}));
  function upgradeSet(set){set.consultants=Array.isArray(set.consultants)?set.consultants:seedConsultants();set.imports=Array.isArray(set.imports)?set.imports:[];set.notifications=Array.isArray(set.notifications)?set.notifications:[];
   for(const row of set.invoices||[]){if(row.consultant&&!set.consultants.some(c=>normalize(c.name).trim()===normalize(row.consultant).trim())){const now=new Date().toISOString();set.consultants.push({id:uuid(),name:row.consultant,phone:'',email:'',active:true,notifications_enabled:true,whatsapp_authorized:false,version:1,created_at:now,updated_at:now});}if(!row.consultant_id){const c=set.consultants.find(c=>normalize(c.name).trim()===normalize(row.consultant).trim());if(c)row.consultant_id=c.id;}if(!('cancelled_at'in row))row.cancelled_at=null;if(!('due_date'in row))row.due_date=null;}
   return set;
  }
  upgradeSet(state);if(state.localData)upgradeSet(state.localData);state.settings=state.settings||{};try{state.settings.billingRules=normalizeRules(state.settings.billingRules||{});}catch(_){state.settings.billingRules=normalizeRules();}state.schemaVersion=2;return state;
 }
 function filterInvoices(rows,query='',filter='all',day=today()){
  const q=normalize(query.trim());return rows.filter(i=>(!filter||filter==='all'||status(i,day)===filter)&&(!q||normalize(i.client_name).includes(q)||normalize(i.nf_number).includes(q)||normalize(i.consultant).includes(q)));
 }
 function uuid(){const bytes=new Uint8Array(16);if(globalThis.crypto&&globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues(bytes);else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
 return {CONSULTANTS,parseMoney,formatMoney,today,dueDate,daysUntil,status,detailedStatus,validateInvoice,summary,filterInvoices,uuid,duplicateKey,normalizePhone,validateConsultant,normalizeRules,collectionTrigger,canWhatsApp,whatsappMessage,whatsappUrl,seedConsultants,upgradeState};
});
