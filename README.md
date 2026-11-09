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
> Para extensões em leitores móveis (**Mihon e forks**): [**manga-extensoes**](https://github.com/Awerkori/manga-extensoes).

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
- 📦 [**Project Nox · Extensões de Mangá**](https://github.com/Awerkori/manga-extensoes) — Distribuição de extensões para Mihon e forks.
- 💻 [**Project Nox · Código-fonte das Extensões de Mangá**](https://github.com/Awerkori/manga-fonte-extensoes) — Código em Kotlin das extensões.
- 🎫 [**Project Nox · Central de Pedidos**](https://github.com/Awerkori/project-nox-requests) — Reporte de erros e solicitações.
- 📊 [**Project Nox · Tracker**](https://awerkori.github.io/project-nox-tracker/) — Dashboard público de status.

---

## 🌟 Créditos

- **Project Nox**: Concepção e arquitetura do fluxo editorial e painel da equipe.
- Equipe interna de tradução, edição e controle de qualidade do Project Nox.

---

## ⚖️ Licença e Governança

Este projeto é software livre licenciado sob os termos da **GNU Affero General Public License versão 3.0** (`AGPL-3.0-only`). Consulte o arquivo [LICENSE](LICENSE) para obter o texto integral inalterado da licença e o arquivo [NOTICE](NOTICE) para informações detalhadas de autoria, dependências e termos de uso.

```
Copyright (C) 2026 Project Nox Contributors & Awerkori

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.
```

### 📌 Interação Remota de Rede (GNU AGPLv3 Seção 13)
O Project Nox adota oficialmente a licença **GNU AGPL versão 3.0**. Nos termos da Seção 13 da AGPLv3, qualquer versão modificada deste portal operada em servidores ou instâncias acessíveis remotamente através de uma rede de computadores deve disponibilizar a todos os usuários remotos a oportunidade de obter o Código-Fonte Correspondente (Corresponding Source) da versão em execução, sem cobrança e através de meio habitual de disponibilização de software em rede.

### 🛡️ Proteção de Identidade e Marca (AGPLv3 Seção 7(e))
A concessão da licença AGPLv3 refere-se estritamente aos direitos autorais do software. Os nomes "Project Nox" e "Awerkori", bem como logotipos associados, identificam a procedência e origem do projeto. A licença **não concede** autorização para o uso de tais sinais distintivos para insinuar homologação, endosso ou representação oficial da equipe interna sem autorização prévia por escrito.

### ⚖️ Governança Operacional
Embora o código seja aberto sob a AGPL 3.0 para estudo e colaboração comunitária, o acesso aos ambientes de produção, credenciais e sessões editoriais da equipe de tradução/edição do Project Nox é restrito aos membros autorizados.
