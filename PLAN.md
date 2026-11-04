# NotaFlow Implementation Plan

> Execute as tarefas autorizadas em paralelo onde forem independentes.

**Goal:** Entregar APK instalável com o controle solicitado e suporte real à sincronização autenticada.
**Architecture:** WebView local com ponte Java restrita; Supabase com equipes e autorização no servidor.
**Tech Stack:** Java Android SDK 35, JavaScript sem framework, PostgreSQL/Supabase.
**Spec:** DESIGN.md

## Tasks

- [ ] Compilação: localizar JDK, baixar SDK oficial, preparar build e assinatura; verificar apksigner e manifest.
- [ ] Regras: testes de cálculo de prazo, limites, ano bissexto, vencimento hoje/amanhã, pago prevalece, busca segura e dashboard; implementar core.js e executar node --test.
- [ ] Interface: painel, notas, clientes/histórico, editor, filtros, configurações, autenticação/equipe; testar navegação real no navegador.
- [ ] Backend: schema com RLS e RPCs transacionais, convites e controle de concorrência; cloud.js com refresh, erros e bloqueio offline; ativar se conexão disponível.
- [ ] Android: armazenamento criptografado, notificações por JobScheduler/cache, pagamento, permissões, reinício e compartilhamento seguro; compilar APK.
- [ ] Revisão independente; corrigir falhas materiais; executar testes, assinatura e inspeção final; entregar APK, fontes e instruções, deixando explícito qualquer serviço pendente.

## Review Focus

Datas sem conversão UTC que altere dia; controle de concorrência; credenciais sem exposição; nenhum acesso remoto pela ponte nativa; dados de clientes tratados como texto; alertas sem duplicação; modo local distinto da sincronização.
