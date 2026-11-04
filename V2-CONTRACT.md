# NotaFlow 2.0 — implementação incremental

Preservar o app 1.1 e os dados locais. Etapas: auditoria (concluída), parser/prévia sem escritas e testes, persistência/consultores e migração, regras/central/painel, WhatsApp manual, adaptador oficial desativado. Não enviar mensagens automaticamente. Abertura do WhatsApp é somente preparação; confirmação de envio é declaração manual do usuário.

## Dados locais

State mantém invoices,events,settings,cloud,mode,localData e acrescenta schemaVersion:2, consultants:[],imports:[],notifications:[]. No localData guardar também consultants/imports/notifications para não misturar contas.

consultant: {id UUID,name,phone:'+5571999999999' ou '',email:'',active:true,notifications_enabled:true,whatsapp_authorized:false,version:1,created_at,updated_at}; cinco nomes existentes sem telefone são sementes locais. Nota guarda consultant_id UUID|null e consultant snapshot string, opcional quando indisponível. Contato sempre vem do cadastro, nunca um número arbitrário no link.

invoice mantém campos v1 e adiciona due_date ISO|null (explícita), consultant_id UUID|null, cancelled_at ISO|null, client_id UUID|null. consultant é nome dinâmico ou ''. funding_source pode 'unspecified' nas importações sem informação, com aviso; manual mantém Banco/Recursos próprios. amount_cents inteiro positivo; datas estritas, prazo 0..3650. Datas de emissão e vencimento distintas. Importação com prazo e vencimento contraditórios gera erro; só vencimento permite derivar prazo da emissão; sem ambos usa defaultTerm.

settings.billingRules = {before_days:1,on_due:true,after_days:1,repeat_days:3,hour:9,daily_summary:true}. before_days/after_days podem null para desativar; repeat_days:0 desativa repetição. Todos intervalos 1..3650 quando habilitados. O proprietário da conta é o administrador; não criar perfis fictícios.

notifications: {id,invoice_id,consultant_id,channel:'whatsapp_manual',status:'prepared'|'confirmed_by_user'|'failed',message,phone,created_at,confirmed_at:null,error:null}. Notas pagas/canceladas e consultores inativos/avisos desativados não geram novas cobranças. Não usar status sent sem resposta da API oficial. O histórico mantém linhas antigas.

imports: {id,file_name,total_count,imported_count,duplicate_count,error_count,ignored_count,created_at,status:'completed'|'partial'|'failed'} sem reter arquivo original inteiro. Chave de duplicação: cliente normalizado sem acento/case/espaços extras + NF normalizada (numérica sem zeros à esquerda; preservar apresentação). Sem sobrescrever registros existentes.

## Core NFCore (proprietário raiz)

API v1 preservada: status() retorna pending|overdue|paid|cancelled, summary() acrescenta cancelled; detailedStatus(i,day?,rules?) retorna current|near|due_today|overdue|paid|cancelled; dueDate usa due_date explícita; validateInvoice aceita consultor dinâmico ou vazio e opção allowUnspecifiedFunding:true para importação; normalizePhone; validateConsultant(input)->{ok,errors,value}; normalizeRules(input); collectionTrigger(invoice,day,rules)->{kind,occurrence}|null; whatsappMessage(invoice,consultant)->string; whatsappUrl(phone,message)->https://wa.me/; duplicateKey(invoice); seedConsultants(); upgradeState(state)->state sem apagar dados.

## NFImporter (agente parser)

FIELDS array {key,label,required,aliases}; parseWorkbook(bytes,{filename,sheetIndex:0,headerRow:0})->table {filename,sheets:[{name,index}],sheetIndex,headers:[{index,label,sample}],rows:[{sourceRow,cells:[{v,t,w,z,f}]}],date1904}; async validateArchive(bytes) antes de ler XLSX, limites reais de expansão. preview(table,{mapping,defaultTerm,existingInvoices,defaults})->{mapping,rows:[{sourceRow,status:valid|invalid|duplicate|empty,value,errors,warnings}],valid:[],counts:{total,valid,invalid,duplicate,empty}}. suggestMapping(headers). Worker local recebe {id,bytes,filename,sheetIndex,headerRow} e responde {id,table}|{id,error}; UI termina worker em15s e pode cancelar. Arquivo5MiB,5000linhas,128colunas,16abas.

## NFCloud (agente backend)

Preservar auth/ensureAccount/listInvoices/listEvents/saveInvoice/setPaid/deleteInvoice. Novos: listConsultants(accountId),saveConsultant(record,expectedVersion),listImports(accountId),listNotifications(accountId),getBillingSettings(accountId)->rules,saveBillingSettings(accountId,rules),cancelInvoice(id,cancelled,expectedVersion),recordNotification(record),confirmNotification(id),importInvoices(accountId,{id,file_name,rows:[invoice],total_count,error_count,duplicate_count,ignored_count})->{import,imported:[invoice],duplicates:[{index,reason}],consultants:[consultant]}. Métodos retornam Promise. expectedVersion obrigatório para edição, idempotência por id do lote. Schema v1 preservado + migrations/002_v2.sql, sem recriar tabelas antigas.

## Native

Bridge existente preservada; chooser respeita accept JSON/Excel/CSV. Novo openWhatsApp(phone,message)->boolean: apenas abre composer ACTION_VIEW, nunca envia. Sem permissões de contatos. cacheInvoices já existente; novo cacheContext(json {scope,consultants,billingRules}) avalia elegibilidade e ledger por conta/nota/regra/ocorrência. Canceladas e pagas ignoradas. Cache/context atualizados na sincronização e ao alterar cadastros/regras. Notificações locais usam JobScheduler+AlarmManager e podem atrasar por política do Android.
