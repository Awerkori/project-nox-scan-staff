# Storage privado da Project Nox

O site continua mostrando **Upload** e **Baixar**. Supabase mantém usuários, permissões, versões e créditos. O Worker transfere partes privadas para o canal STAFF SCAN, sem fazer os arquivos atravessarem o egress do Supabase.

## Limites e custos

A [Bot API pública](https://core.telegram.org/bots/api#getfile) permite downloads de até 20 MB e uploads de documentos de até 50 MB. Portanto, cada arquivo é dividido em partes de **8 MiB**; o navegador recompõe o nome e conteúdo originais, verificando SHA-256 de cada parte. Não é um upload único de 200 MB para a Bot API. O limite da aplicação é **1 GiB** por versão (128 partes). Para arquivos grandes, prefira desktop; a montagem do download usa armazenamento/memória do navegador e não foi projetada para dispositivos com poucos recursos.

O [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) tem quotas de requisições, CPU e memória. Não requer plano pago, mas não significa capacidade ilimitada ou SLA. Muitos uploads podem sofrer espera por limites do Telegram; o site mostra progresso e respeita respostas de limitação. O bot não tem permissão para apagar mensagens ou promover administradores. Não apague o canal, mensagens ou o bot: eles são parte do armazenamento. Telegram não substitui backup nem oferece criptografia ponta a ponta em canais.

## Implantação

1. Aplicar somente a migration pendente `20260906010000_telegram_artifact_storage.sql` — começa desativada.
2. Publicar `npx wrangler deploy --config workers/telegram-storage/wrangler.jsonc`.
3. Configurar `TELEGRAM_BOT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_ANON_KEY` como secrets do Worker. O script `node scripts/configure-telegram-worker.mjs` lê a credencial do bot em `NOX_TELEGRAM_TOKEN_FILE` (arquivo privado fora do repositório) e obtém as chaves pela CLI autenticada; usa stdin, não imprime valores.
4. Publicar o frontend compatível antes de ativar. Pelo backend autorizado, configurar `artifact_storage_settings.bridge_url` e `telegram_enabled=true`. Nem administradores da staff podem editar essa tabela pelo frontend.

O bot e o ID do canal são selecionados no servidor. Não cadastrar token como variável `VITE_*`, GitHub Variable, URL do site ou metadado de artifact. O endpoint `/health` revela apenas prontidão e tamanho de parte, nunca credenciais.

## Integridade e falhas

O banco autoriza cada parte com a sessão do membro, cargo, atribuição, dependências e etapa ativa. A chave privilegiada só confirma a resposta do Telegram e lê referências privadas **depois** da autorização do usuário. `provider_key` não contém o file_id do Telegram. Até um administrador autenticado não pode forjar confirmação de transferência.

Cada parte possui uma reserva exclusiva. Uma parte confirmada não é reenviada. Falha antes de tocar o Telegram ou resposta 429 libera somente a reserva não enviada. Timeout ambíguo não dispara reenvio cego, pois a mensagem pode ter chegado. Nesse caso, o arquivo não fica disponível nem conclui a etapa: uma nova tentativa do usuário cria uma nova versão, preservando anteriores. Reservas incompletas ficam como `PENDING`, fora da lista de arquivos prontos, para diagnóstico; nenhuma exclusão automática é feita no Telegram.

A finalização exige todas as partes e tamanho exato. Downloads verificam SHA-256 e só oferecem o arquivo completo ao usuário. URLs do Telegram e bot token nunca saem do Worker. Downloads de artifacts antigos do Supabase continuam usando URLs assinadas de cinco minutos.

## Validação

- `npm run test`: transporte, erros sanitizados, origem, autenticação, tamanho, hash e idempotência do Worker.
- `npm run test:telegram`: PostgreSQL isolado, concorrência, RLS, finalização incompleta, manifesto e integração com workflow; confirmações Telegram simuladas explicitamente.
- `node scripts/test-telegram-live.mjs`: teste real de 8 MiB no canal. Cria uma obra identificada como teste, usa sessão temporária autorizada do proprietário e não apaga dados.
- `node scripts/test-telegram-live.mjs browser`: exige o frontend compatível em produção, ativa o provider e testa 200 MiB pelo Upload/Baixar reais, verifica metadata, canal e checksum. Salva screenshots e arquivos em `test-results/`, ignorado pelo Git. Não é um teste de login GitHub; esse login foi confirmado separadamente pelo membro.
- `node scripts/test-telegram-live.mjs finish`: somente após o teste grande, percorre o workflow remoto da obra técnica até Upados, preservando arquivos e créditos e comprovando compatibilidade com um artifact antigo do Supabase.
- `node scripts/test-telegram-live.mjs audit`: verifica os canais publicados em três larguras, ausência de erros de console, ordem do workflow, histórico, notificações internas e e-mail opcional sem fila de erros.

**Evidência em 07/09/2026:** o navegador no Pages enviou e recuperou **200 MiB (209.715.200 bytes)**, divididos em 25 partes confirmadas no STAFF SCAN. Nome e SHA-256 coincidiram. Houve uma resposta real 429 do Telegram; a transferência aguardou e continuou. Acesso anônimo e confirmação forjada pelo administrador foram negados. O capítulo técnico percorreu RAW, Clean/Tradução, Type, QC e publicação; as cinco contribuições e versões foram preservadas. Um arquivo antigo privado do Supabase também foi baixado com tamanho correto. A obra **TESTE TÉCNICO — Telegram Storage** permanece identificada em Upados como evidência, sem ocupar as filas ativas.

Para interromper novos uploads Telegram, configure `telegram_enabled=false` pelo backend sem apagar `bridge_url`: os downloads existentes continuam funcionando. Isso não migra arquivos automaticamente para outro provedor.
