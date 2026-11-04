# Instrucoes permanentes do NotaFlow

## Sincronizacao obrigatoria com o GitHub

Regra solicitada e autorizada expressamente pelo usuario, valida em todas as sessoes futuras neste projeto. Repositorio privado: https://github.com/rodrigosantossilv/notaflow; branch principal: `main`.

- Sempre que criar, alterar ou apagar arquivos do projeto, revise as mudancas, execute as verificacoes adequadas e faca automaticamente `git add`, `git commit` e `git push origin main`, sem esperar um novo pedido. Agrupe os arquivos de uma mesma alteracao coerente em um commit.
- Escreva mensagens de commit claras em portugues, descrevendo a mudanca realizada.
- Antes de adicionar arquivos, verifique o diff e os arquivos novos. Nunca envie segredos, credenciais, tokens, senhas, chaves privadas/de assinatura, dados pessoais do aplicativo, perfis de navegador ou arquivos `.env`.
- Respeite o `.gitignore`; nao use `git add -f` para incluir arquivos privados ou gerados.
- Preserve as alteracoes preexistentes do usuario. Nao descarte trabalho e nao reescreva historico.
- Se houver conflito, erro de push, divergencia ou qualquer operacao que possa apagar historico, pare e avise o usuario. Nunca use `push --force`, `--force-with-lease`, reset destrutivo ou exclusao de branch sem autorizacao explicita.
- O usuario tambem autorizou usar a conexao GitHub existente, como no Brasa. O repositorio foi criado no navegador e essa conexao recebeu acesso especificamente ao NotaFlow. Leituras pelo conector sao permitidas; nenhum envio por conector pode ser apresentado como igualdade de commits sem verificacao.
- O GitHub CLI ja foi autenticado legitimamente pelo navegador. Nesta instalacao, sua configuracao privada fica em `../github-cli`, FORA da raiz do projeto. Nunca copie essa pasta, tokens ou `hosts.yml` para os fontes, arquivos de entrega ou commits.
- Para enviar neste ambiente Windows, use `.\toolchain\push-github.ps1 -GitHubConfigDirectory '..\github-cli'` apos o commit. O script usa a autenticacao do `gh` somente em memoria porque o helper padrao do Git nao funciona no sandbox; nao grave o header de autenticacao em scripts, logs ou configuracoes Git.
- Se a autenticacao deixar de funcionar, use o fluxo normal `gh auth login` pela sessao do navegador ou informe a necessidade ao usuario. Nunca procure tokens em cookies/perfis, contorne controles de acesso ou altere a visibilidade do repositorio para conseguir acesso.
- Enquanto o `origin` nao estiver configurado ou o envio nao tiver sido confirmado, informe que a sincronizacao esta pendente. Nunca declare sincronizacao concluida apenas porque o commit local existe.
- Ao concluir cada conjunto de alteracoes, confirme que `git rev-parse HEAD` coincide com `git ls-remote origin refs/heads/main` e que nao ficaram alteracoes do trabalho sem commit.

## Estrutura e verificacao

- `android/`: aplicativo Android Java com interface local HTML/CSS/JavaScript.
- `backend/`: esquema e migracoes Supabase; `tests/`: testes Node.js e Java.
- Previa local: `node serve.mjs` na raiz, em `http://127.0.0.1:8879`.
- Dependencias de teste: `npm.cmd ci --prefix test-tools --ignore-scripts --no-audit --no-fund`.
- A versao 2.0 esta em desenvolvimento. `tests/whatsapp-business.test.cjs` especifica uma etapa futura ainda sem implementacao; nao afirme que essa etapa esta pronta.
- Backend remoto e envio automatico de WhatsApp nao estao ativados. Credenciais de servidor nunca pertencem ao APK ou ao Git.
