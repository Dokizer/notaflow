# NotaFlow

Aplicativo Android para controlar notas fiscais, valores, bancos ou recursos próprios, consultores, vencimentos e pagamentos. Inclui painel, notificações do celular, importação de Excel/CSV e Central de Cobranças com abertura manual do WhatsApp.

A versão 2.0 está em desenvolvimento. A sincronização entre celulares depende da configuração do Supabase descrita em [backend/README.md](backend/README.md). Nenhum servidor remoto ou envio automático de WhatsApp está ativado.

## Instalar e executar

No Android 8 ou superior, instale o APK fornecido separadamente e permita as notificações quando solicitado. APKs, dados pessoais e chaves de assinatura não são versionados.

Para executar a interface no computador, instale Node.js 24 e rode na raiz:

```powershell
node serve.mjs
```

Abra `http://127.0.0.1:8879`. Notificações nativas e integrações Android exigem o APK.

## Testes

```powershell
npm.cmd ci --prefix test-tools --ignore-scripts --no-audit --no-fund
node --test tests/core.test.cjs tests/v2-core.test.cjs tests/cloud.test.cjs tests/db.test.cjs tests/db-v2.test.cjs tests/importer.test.cjs tests/frontend-storage.test.cjs
```

O teste de navegador requer uma sessão isolada. `tests/whatsapp-business.test.cjs` descreve a etapa futura do adaptador oficial, ainda sem implementação.

## Gerar APK no Windows

Use JDK 17 ou superior, Android Platform 35 em `toolchain/sdk/platform` e Build Tools 35 em `toolchain/sdk/build-tools`, obtidos pelo SDK Manager. Configure `JAVA_HOME` e execute:

```powershell
.\toolchain\build.ps1
```

O resultado fica em `dist/NotaFlow.apk`. Guarde a chave gerada em `toolchain/signing` em local privado: futuras atualizações devem usar a mesma chave. Nunca envie essa pasta ao GitHub.
