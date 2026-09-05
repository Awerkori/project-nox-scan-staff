# Project Nox Scan Staff

Painel privado de produção para a staff da Project Nox. O frontend é React + TypeScript + Vite e pode ser hospedado no GitHub Pages; dados, arquivos e autorização ficam no Supabase, protegidos por RLS.

## O que entrega

- Login somente com GitHub OAuth, convites por login e reivindicação segura para contas que já fizeram login.
- Cargos múltiplos, filas automáticas por etapa e workflow RAW → Clean/Tradução paralelos → Type → QC → Pronto.
- RPCs transacionais para assumir, concluir, reprovar e aprovar tarefas.
- Notificações persistentes por cargo e avisos por e-mail via outbox, Edge Function e Resend quando uma etapa é liberada.
- Catálogo editorial separado da produção; o workflow nasce somente quando um Raw Provider assume um item.
- Arquivos e capas privados, versões reservadas com lock, créditos imutáveis, comentários, atividade, notificações e Realtime.
- Abstração de storage: Supabase Storage hoje; `TelegramStorageProvider` reservado para uma futura Edge Function/serviço seguro.

## Segurança

O site no Pages não contém token privilegiado. Use somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`; a anon key é pública por design e a proteção é feita pelas políticas RLS. Nunca use `service_role`, segredo OAuth ou token Telegram no cliente.

Usuários autenticados não entram automaticamente: só existem dados visíveis depois de constarem em `staff_members` como ativos. O bootstrap do primeiro administrador é manual e seguro, após o primeiro login OAuth de `Awerkori`:

```sql
insert into public.staff_members(user_id, github_login, display_name, is_active, is_admin)
select id, github_login, coalesce(display_name, 'Awerkori'), true, true
from public.profiles where lower(github_login) = 'awerkori';

insert into public.user_roles(user_id, role_code)
select user_id, 'ADMIN' from public.staff_members
where lower(github_login) = 'awerkori'
on conflict do nothing;
```

Administradores gerenciam convites, cargos e ativação no painel. O banco impede a remoção concorrente do último administrador ativo; a migration é a fonte da verdade para RLS e integridade.

## Configuração Supabase

1. Crie um projeto Supabase.
2. Aplique em ordem somente as migrations pendentes de [`supabase/migrations`](supabase/migrations). Nunca reexecute migrations já aplicadas. O histórico remoto foi reconciliado com as cinco migrations antigas aplicadas manualmente; publicação, integridade/Auth e confiabilidade de e-mail foram aplicadas pela CLI em 05/09/2026.
3. Em **Authentication → Providers**, habilite GitHub e informe Client ID/secret somente no Supabase.
4. Configure a callback OAuth indicada pelo Supabase (normalmente `https://<project-ref>.supabase.co/auth/v1/callback`) no GitHub OAuth App.
5. Em **Authentication → URL Configuration**, adicione `https://awerkori.github.io/project-nox-scan-staff/` e a URL local de desenvolvimento como redirect URLs.
6. Copie `.env.example` para `.env.local`, preenchendo URL e anon key. Não versione esse arquivo.
7. Faça login uma vez como `Awerkori`, execute o SQL de bootstrap acima e teste uma conta não autorizada: ela deve receber “Acesso não autorizado” e não obter linhas privadas.

O bucket `scan-artifacts` é privado e é criado pela migration. Para integrar Telegram futuramente, implemente a operação numa Edge Function/serviço confiável e registre `provider='telegram'` e `provider_key`; nenhum token Telegram pertence ao browser.

## Desenvolvimento

```bash
npm install
npm run lint
npm run test
npm run build
npm run dev
```

Os testes em [`src/workflow.test.ts`](src/workflow.test.ts) cobrem a regra central: RAW libera Clean e Tradução; Type só abre quando ambos terminam; QC aprova para Ready ou reprova de volta para a etapa escolhida. As funções SQL são a proteção efetiva contra conflito de tarefa e permissões no ambiente real.

### Reserva de tarefa e notificações

`claim_stage` bloqueia a linha com `FOR UPDATE`, exige o cargo da etapa e só aceita estado `AVAILABLE`. O índice parcial `one_active_assignment_per_stage` é uma segunda barreira: dois cliques simultâneos não podem resultar em dois responsáveis ativos. O perdedor recebe a mensagem de conflito da RPC.

Ao ocorrer uma transição real para `AVAILABLE`, o banco avisa os membros ativos do cargo correspondente (e administradores no site). RAW libera Clean e Tradução em paralelo; Clean + Tradução liberam Type; Type libera QC. Devolver uma tarefa à fila não dispara outro e-mail da mesma liberação. Renderizações, reloads e Realtime não criam notificações.

### E-mails de produção

A migration `20260904240000_catalog_management_and_email_outbox.sql` cria uma outbox durável, deduplicada por etapa/liberação/destinatário. O webhook assíncrono tenta acordar a Edge Function imediatamente e um cron por minuto recupera falhas. O workflow nunca aguarda o Resend.

Depois de aplicar a migration:

```bash
supabase functions deploy send-production-emails --no-verify-jwt
supabase secrets set RESEND_API_KEY=re_... RESEND_FROM="Project Nox <staff@seudominio.com>" EMAIL_WORKER_SECRET=um-segredo-forte STAFF_APP_URL=https://awerkori.github.io/project-nox-scan-staff/
```

Cadastre no Vault do projeto a URL e o mesmo segredo do worker:

```sql
select vault.create_secret('https://SEU-PROJETO.supabase.co', 'project_url');
select vault.create_secret('O-MESMO-EMAIL_WORKER_SECRET', 'email_worker_secret');
```

`RESEND_API_KEY` e `EMAIL_WORKER_SECRET` existem somente nos secrets da Edge Function/Vault. O remetente precisa usar um domínio verificado no Resend. Falhas e tentativas ficam disponíveis para administradores em `production_email_outbox.last_error` e não alteram o estado do capítulo.

## Deploy

O workflow [`deploy-pages.yml`](.github/workflows/deploy-pages.yml) executa lint, testes e build antes de publicar no GitHub Pages. Defina o Pages do repositório como **GitHub Actions**. As variáveis públicas `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` devem ser adicionadas como Variables/Secrets de Actions antes do primeiro deploy funcional; elas não são suficientes para burlar RLS.

O app usa `HashRouter`, portanto URLs do Pages não sofrem 404 em rotas internas. URL prevista: `https://awerkori.github.io/project-nox-scan-staff/`.

## Validação da revisão de UX

`npm run test:db` cria um banco **novo e exclusivamente local** em `127.0.0.1:55432`, usando o usuário do sistema com permissão de criar bancos/roles. Não aponta para produção, não apaga bancos existentes e executa todas as migrations, RLS e RPCs. Auth/Storage têm schemas compatíveis; apenas pg_net, cron e Vault são simulados.

`npm run test:browser` usa o React real e esse PostgreSQL com contas separadas por cargo. Percorre upload, conclusão, os três retornos de QC, publicação, rotas negadas e layouts desktop/notebook/mobile. O envelope HTTP do Supabase, a sessão OAuth e o transporte de arquivos são locais; isso **não comprova login externo ou entrega real de e-mail**. Screenshots ficam em `test-results/` (ignoradas pelo Git). Os dois testes são obrigatórios no deploy do Pages.

`tests/remote-smoke.sql` valida as identidades confirmadas de administrador e Typesetter, bloqueios de RPC, proteção do último admin e reentrada no banco remoto. Todas as escritas de teste são revertidas.

`node scripts/check-production.mjs` abre o Pages publicado em três larguras, verifica o console, o encaminhamento ao GitHub e a negação de acesso anônimo às tabelas/RPCs privadas. Não autentica em nome de outra pessoa nem altera dados. O login GitHub completo precisa ser confirmado pelo titular da conta.

`node scripts/email-worker.mjs setup /caminho/privado/worker.env` configura somente o segredo do worker e URL no Vault/Edge Function, sem imprimir valores. O arquivo deve conter `EMAIL_WORKER_SECRET` (64 caracteres hexadecimais) e `STAFF_APP_URL`; proteja-o e remova-o após a configuração. `diagnose` consulta a configuração e os domínios no Resend; uma chave restrita a envio não pode listar domínios. `run` processa a fila. O remetente deve estar configurado como `RESEND_FROM`. Tentativas usam chave de idempotência estável, backoff e limite de repetição; falhas do disparador ficam em `email_worker_diagnostics`.
