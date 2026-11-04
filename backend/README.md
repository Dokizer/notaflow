# Backend do NotaFlow

Este diretório contém a migração inicial 1.1, preservada, e a atualização incremental 2.0. Nenhum projeto remoto foi criado ou configurado por esta entrega.

## Configurar Supabase

1. Crie um projeto Supabase na sua conta.
2. Em um projeto novo, execute `schema.sql` e, depois, `migrations/002_v2.sql`, uma vez cada. Em um banco NotaFlow 1.1 existente, faça backup e execute **somente** `migrations/002_v2.sql`; não execute novamente `schema.sql`. As duas migrações são transacionais e pressupõem os papéis `anon`/`authenticated` e Supabase Auth existentes. A atualização não reescreve notas antigas nem eventos históricos.
3. Ative autenticação por e-mail e senha. Se a confirmação de e-mail estiver ativada, confirme o endereço antes de entrar no aplicativo. Configure o provedor de envio de e-mail e os limites de autenticação conforme o uso real do projeto.
4. Nos Ajustes de cada celular, preencha a URL HTTPS do projeto, no formato `https://seu-projeto.supabase.co`, e a chave **publishable** ou **anon pública**. Nunca use `service_role`, `sb_secret` ou senha do banco no aplicativo. `android/assets/config.js` é entregue vazio.
5. Crie uma conta no aplicativo e entre com o **mesmo e-mail e a mesma senha em todos os seus celulares**. Cada login tem um único controle privado chamado **Meu controle**. Não há convites, equipes ou grupos. Outro login recebe outro controle isolado.
6. Atualize a lista em ambos os dispositivos para conferir as alterações. Escritas exigem conexão. Se uma gravação tiver resultado incerto, atualize antes de tentar novamente; o cliente não repete automaticamente uma escrita que pode ter sido aplicada.

O modo local continua disponível. Cadastros existentes apenas no dispositivo não são enviados automaticamente para a conta. O aplicativo apresenta a importação quando aplicável; notas antigas precisam ter os dados obrigatórios completados antes de serem salvas na nuvem.

## Contrato

`ensure_account()` cria ou recupera o controle do usuário autenticado, sem aceitar identificadores de outro usuário. O identificador interno `workspace_id` é mantido no protocolo e representa somente esse controle privado. O cliente expõe `ensureAccount()`, `listInvoices(workspaceId)`, `listEvents(workspaceId)`, `saveInvoice(invoice, expectedVersion)`, `setPaid(id, paid, expectedVersion)` e `deleteInvoice(id, expectedVersion)`.

Uma nota exige cliente (1–160 caracteres), NF (1–80), data ISO válida de 1900 a 9999, prazo de 0 a 3650 dias corridos e valor inteiro em centavos de 1 a 99.999.999.999. O consultor é dinâmico e opcional; `consultant_id` e `client_id` são UUIDs opcionais restritos à mesma conta. Ao vincular um consultor, o servidor copia seu nome para o snapshot da nota. Os cinco nomes da versão anterior são sementes editáveis sem telefone. Notas antigas mantêm seus snapshots e vínculos nulos; notificações aceitam correspondência exata de nome normalizado com um consultor da conta. `due_date`, quando presente, deve corresponder à emissão mais o prazo. `funding_source` aceita `bank`, `own` ou `unspecified` (informação ausente na importação); o banco é obrigatório somente para `bank`. O servidor rejeita campos desconhecidos ou tentativas de definir pagamento, cancelamento, autor, versão e timestamps dentro de `p_invoice`.

Novos métodos do cliente: `listConsultants`, `saveConsultant`, `listImports`, `listNotifications`, `getBillingSettings`, `saveBillingSettings`, `cancelInvoice`, `recordNotification`, `confirmNotification` e `importInvoices`, conforme `V2-CONTRACT.md`. Configurações ficam em `billing_settings(workspace_id,rules,updated_at)`; o RPC retorna o objeto `rules` diretamente. Somente o proprietário autenticado da conta pode alterá-las.

`importInvoices(accountId,batch)` recebe UUID do lote, nome de arquivo, linhas validadas e contagens. Conserve o mesmo UUID **e o mesmo conteúdo** ao repetir explicitamente uma tentativa incerta: o banco retorna o resultado original, sem reinserir. Reutilizar o UUID com conteúdo diferente produz conflito. O hash SHA-256 e o resultado do lote são persistidos; o arquivo original não é guardado. O lote é atômico, limitado a 5.000 linhas e bloqueia a conta para coordenar importações e gravações manuais. A duplicidade usa o par cliente normalizado sem acentos/caixa/espaços extras e NF normalizada, removendo zeros à esquerda das NFs numéricas. As notas existentes nunca são sobrescritas. Não se cria índice único sobre essa chave porque duplicações antigas precisam sobreviver à migração. Novas notas manuais duplicadas são rejeitadas; editar uma duplicação histórica continua possível.

Notificações manuais só aceitam o telefone atual do consultor responsável e bloqueiam notas pagas/canceladas e consultores inativos/com avisos desativados. Abertura do WhatsApp não confirma entrega: `prepared` registra preparação, `failed` registra falha de abertura e `confirmed_by_user` registra somente a declaração manual do usuário. O histórico permanece após excluir a nota. `entity_events` registra alterações de cadastros, regras, importações e notificações e também é imutável.

Use `p_expected_version = null` somente para criar. Edições, pagamento e exclusão exigem a versão atual. As operações bloqueiam a linha e retornam `NF_CONFLICT` para versão antiga. O pagamento usa o horário do servidor por RPC separado. A alteração de status para o mesmo valor, com versão atual, não cria evento duplicado.

As tabelas têm RLS para leitura e não concedem escrita direta aos clientes. As funções de escrita verificam `auth.uid()`, fixam `search_path` e usam referências de esquema explícitas. Eventos são gerados na mesma transação por trigger, guardam os dados anteriores/posteriores e preservam nome/NF e identificador após exclusão. Triggers rejeitam alteração, exclusão e truncamento do histórico. O proprietário administrativo do banco continua capaz de administrar triggers e permissões; os controles não substituem backups ou a proteção das credenciais administrativas. A remoção de usuários/controles com histórico exige uma política administrativa explícita de retenção, pois as chaves estrangeiras impedem exclusão em cascata.

## Verificação local

Com Node.js e as dependências já presentes em `test-tools/node_modules`:

```powershell
node --test tests/cloud.test.cjs tests/db.test.cjs tests/db-v2.test.cjs
```

Os testes executam PostgreSQL/PGlite com papéis e contexto de autenticação simulados. O teste 2.0 instala o schema 1.1, insere dados com duplicações antigas, snapshots e pagamento, aplica a atualização real e compara IDs, valores, versões e eventos. Também cobre isolamento, chaves compostas entre contas, validação financeira, conflitos, cancelamento, supressão de cobranças, replay e rollback de lotes. A conectividade de um projeto Supabase real deve ser conferida após a configuração acima.
