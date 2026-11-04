# Instrucoes permanentes do NotaFlow

## Sincronizacao obrigatoria com o GitHub

Regra solicitada e autorizada expressamente pelo usuario, valida em todas as sessoes futuras neste projeto:

- Sempre que criar, alterar ou apagar arquivos do projeto, revise as mudancas, execute as verificacoes adequadas e faca automaticamente `git add`, `git commit` e `git push origin main`, sem esperar um novo pedido. Agrupe os arquivos de uma mesma alteracao coerente em um commit.
- Escreva mensagens de commit claras em portugues, descrevendo a mudanca realizada.
- Antes de adicionar arquivos, verifique o diff e os arquivos novos. Nunca envie segredos, credenciais, tokens, senhas, chaves privadas/de assinatura, dados pessoais do aplicativo, perfis de navegador ou arquivos `.env`.
- Respeite o `.gitignore`; nao use `git add -f` para incluir arquivos privados ou gerados.
- Preserve as alteracoes preexistentes do usuario. Nao descarte trabalho e nao reescreva historico.
- Se houver conflito, erro de push, divergencia ou qualquer operacao que possa apagar historico, pare e avise o usuario. Nunca use `push --force`, `--force-with-lease`, reset destrutivo ou exclusao de branch sem autorizacao explicita.
- Se o GitHub CLI estiver ausente ou sem login, informe como instalar/autenticar com `gh auth login` e aguarde; nao substitua por outra forma de criar o repositorio.
- Enquanto o `origin` nao estiver configurado ou o envio nao tiver sido confirmado, informe que a sincronizacao esta pendente. Nunca declare sincronizacao concluida apenas porque o commit local existe.
- Ao concluir cada conjunto de alteracoes, confirme que `git rev-parse HEAD` coincide com `git ls-remote origin refs/heads/main` e que nao ficaram alteracoes do trabalho sem commit.

## Estrutura e verificacao

- `android/`: aplicativo Android Java com interface local HTML/CSS/JavaScript.
- `backend/`: esquema e migracoes Supabase; `tests/`: testes Node.js e Java.
- Previa local: `node serve.mjs` na raiz, em `http://127.0.0.1:8879`.
- Dependencias de teste: `npm.cmd ci --prefix test-tools --ignore-scripts --no-audit --no-fund`.
- A versao 2.0 esta em desenvolvimento. `tests/whatsapp-business.test.cjs` especifica uma etapa futura ainda sem implementacao; nao afirme que essa etapa esta pronta.
- Backend remoto e envio automatico de WhatsApp nao estao ativados. Credenciais de servidor nunca pertencem ao APK ou ao Git.
