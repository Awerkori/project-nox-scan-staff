# Project Nox · Central Staff

Painel privado de gerenciamento editorial, controle de tarefas e fluxo de produção para a equipe do **Project Nox** (React, TypeScript, Vite, Supabase RLS, Edge Functions e Cloudflare Workers).

---

🌐 **Painel de Produção (Acesso Restrito):** [awerkori.github.io/project-nox-scan-staff](https://awerkori.github.io/project-nox-scan-staff/)

---

## 🎯 Para quem é este repositório?

Este repositório é uma aplicação interna dedicada à **equipe editorial e de scanlation do Project Nox** (Raw Providers, Tradutores, Revisores, Cleaners/Redrawers, Typesetters, QCs e Administradores).

> [!NOTE]
> Se você procura a **plataforma pública de leitura de mangás**, acesse:  
> ➡️ [**Project Nox · Plataforma Web de Mangá**](https://github.com/Awerkori/project-nox-manga)  
> Para extensões móveis (Mihon): [**manga-extensoes**](https://github.com/Awerkori/manga-extensoes).

---

## 🚀 Funcionalidades da Central

- **Controle de Acesso Estrito:** Autenticação via GitHub OAuth com whitelist controlada por Row Level Security (RLS) no Supabase.
- **Workflow Linear & Paralelo:** Fluxo de produção estruturado em etapas:
  - RAW → Clean / Redraw e Tradução / Revisão em paralelo → Typesetting → Quality Check (QC) → Pronto para Publicação.
- **RPCs Transacionais Atômicas:** Funções PostgreSQL dedicadas para assumir (`claim_stage`), devolver, aprovar e reprovar etapas sem condições de corrida.
- **Armazenamento Híbrido Resiliente:** Upload de arquivos e partes através do worker de transporte privado (Telegram Storage) e Supabase Storage histórico.
- **Notificações em Tempo Real:** Atualizações reativas via Supabase Realtime para a equipe por cargo e etapa liberada.

---

## 🔒 Segurança e Autorização

O frontend hospedado no GitHub Pages não contém tokens privilegiados:
- Utiliza unicamente as credenciais públicas do cliente (`VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`).
- Todas as tabelas são blindadas com **Row Level Security (RLS)** ativo.
- Usuários autenticados no GitHub só visualizam dados e tarefas se constarem expressamente na tabela `public.staff_members` como membros ativos.
- O token da role administrativa (`service_role`), segredos de OAuth e bots permanecem restritos aos ambientes de backend.

---

## 💻 Desenvolvimento Local

### Pré-requisitos
- **Node.js** 20+ e `npm`
- Projeto Supabase com as migrações aplicadas

### Instalação e Execução
```bash
# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env.local
# Preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY

# Iniciar servidor local
npm run dev

# Executar testes unitários e de fluxo
npm run test

# Gerar build estático
npm run build
```

---

## 🔗 Ecossistema Project Nox

- 🌐 [**Project Nox · Plataforma Web de Mangá**](https://github.com/Awerkori/project-nox-manga) — Plataforma web oficial para leitura pública.
- ⚙️ [**Project Nox · Importer**](https://github.com/Awerkori/project-nox-importer) — Serviço de ingestão contínua 24/7.
- 📦 [**Project Nox · Extensões de Mangá**](https://github.com/Awerkori/manga-extensoes) — Repositório de extensões para leitores móveis.
- 💻 [**Project Nox · Código-fonte das Extensões de Mangá**](https://github.com/Awerkori/manga-fonte-extensoes) — Código em Kotlin das extensões.
- 🎫 [**Project Nox · Central de Pedidos**](https://github.com/Awerkori/project-nox-requests) — Reporte de erros e solicitações.
- 📊 [**Project Nox · Tracker**](https://awerkori.github.io/project-nox-tracker/) — Dashboard público de status.

---

## ⚖️ Licença e Governança

Software de gestão interna do Project Nox. Uso exclusivo para membros autorizados da equipe de tradução e edição.
