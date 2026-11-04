# NotaFlow 1.1 — projeto atual

Aplicativo Android em português. Área de grupos removida. Cada NF tem cliente, número, faturamento, prazo, consultor obrigatório entre cinco nomes fornecidos, valor em centavos e banco/recursos próprios. Notas anteriores são preservadas e exigem completar os novos campos ao editar. Prazo inicial5dias corridos; atraso começa após o dia do vencimento.

Interface local WebView com ponte restrita e armazenamento Keystore/AES-GCM. Painel por quantidade/valor, busca e filtros, confirmação manual, histórico e exportações. Alarme nativo diário às9h envia resumo do cache dentro do receiver, com atualização remota separada e fallback JobScheduler. Há deduplicação diária e notificação imediata de pagamento. Android pode adiar alarmes. Sem validação em aparelho físico.

Sincronização opcional Supabase usa o mesmo login entre celulares. ensure_account cria um controle privado; RLS, RPCs de mutação com versão otimista e auditoria imutável. Nenhum servidor remoto foi provisionado. workspace_id é somente identificador interno da conta; não existem convites ou grupos na interface.
