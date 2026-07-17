# n8n Foundations (Schema Postgres + Credenciais) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar a base compartilhada que os 4 planos seguintes (Roteiro/Voz/Legenda, Assets/Render, Aprovação/Publish, Main Pipeline/Error/Cleanup) vão consumir: schema Postgres `postador` criado no banco que já serve o n8n, credencial Postgres registrada no n8n, e todas as chaves de API externas disponíveis como env var do container n8n.

**Architecture:** Nenhum acesso SSH/psql direto é necessário. O Postgres do próprio n8n (já rodando no stack `n8n-with-postgres-and-worker` do Coolify) ganha um schema adicional `postador` — a DDL roda através de um workflow n8n descartável (`n8n-workflows/db-setup.json`) com 1 node Postgres, executado uma vez via `mcp__n8n__execute_workflow`. Chaves de API externas (OpenRouter, Pexels, Pixabay, Telegram, bearer tokens dos 3 microserviços) **não** viram Credential objects do n8n — viram env vars do container n8n (via API do Coolify), lidas em runtime pelos nodes HTTP Request via expression `{{$env.NOME_DA_VAR}}`. Isso evita depender de nomes exatos de tipos de credencial genérica (`httpHeaderAuth`/`httpQueryAuth`) que variam entre versões do n8n, e mantém o padrão já usado neste repo de nunca gravar segredo em arquivo versionado.

**Tech Stack:** API REST do n8n (`X-N8N-API-KEY`), API REST do Coolify (`Authorization: Bearer`), node `n8n-nodes-base.postgres` (operação `executeQuery`), `mcp__n8n__search_workflows` / `mcp__n8n__execute_workflow`.

---

## Convenção usada nos 4 próximos planos (ler antes de implementar qualquer um deles)

- **Contrato entre sub-workflows**: todo sub-workflow começa com um node `n8n-nodes-base.executeWorkflowTrigger` (não `manualTrigger`/`webhook`) e espera `{ "run_id": <int>, "niche_id": <int> }` no item de entrada. Lê o que precisa de `postador.niches`/`postador.video_runs` via node Postgres logo em seguida, grava o resultado de volta na mesma linha de `video_runs` antes de terminar.
- **Autenticação HTTP externa**: todo node `n8n-nodes-base.httpRequest` que chama API externa ou um dos 3 microserviços usa `sendHeaders: true` com um header `Authorization` cujo valor é uma expression (prefixo `=`) lendo `{{$env.NOME_DA_VAR}}` — nunca credencial genérica, nunca valor hardcoded.
- **Arquivos de workflow**: 1 arquivo JSON por workflow em `n8n-workflows/*.json`, versionado. Placeholders de IDs específicos da instância (ex. credencial Postgres) ficam como `__PG_CRED_ID__` no arquivo versionado, substituídos por `sed`/PowerShell no momento do `POST`/`PATCH` pra API do n8n — nunca commitados já resolvidos.
- **IDs/uuids específicos da instância** (uuid do app n8n no Coolify, id da credencial Postgres, ids dos workflows registrados) ficam em `docs/superpowers/plans/n8n-instance.local.md`, que é `.gitignore`d — os próximos 4 planos leem esse arquivo em vez de repetir a descoberta.

---

## Task 1: Localizar app n8n no Coolify e credenciais de conexão do Postgres interno

**Files:** nenhum arquivo de código — só chamadas de API, valores anotados no arquivo local do Task 5.

⚠️ **Achado desta sessão**: n8n roda como **Coolify Service** (compose stack `n8n-with-postgres-and-worker`), **não** como Application — `GET /api/v1/applications` não lista o n8n. Usar `/api/v1/services` e o uuid do *service*, não de uma application. Além disso, **a API do Coolify nunca devolve o `value` de nenhuma env var** (nem em Application nem em Service — só metadados `key`/flags), então segredos (senha do Postgres) precisam ser revelados manualmente na UI.

- [ ] **Step 1: Listar services do Coolify e achar o do n8n**

```bash
COOLIFY_BASE="http://137.131.180.11:8000"
TOKEN="<obter com o operador — não versionar>"
curl -s "$COOLIFY_BASE/api/v1/services" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  | jq '.[] | select(.name | test("n8n"; "i")) | {uuid, name}'
```

Expected: 1 objeto com `uuid` do service n8n (guardar como `$N8N_SERVICE_UUID`).

- [ ] **Step 2: Confirmar o host interno do Postgres (via sub-recursos do service)**

```bash
curl -s "$COOLIFY_BASE/api/v1/services/$N8N_SERVICE_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  | jq '{status, databases: [.databases[] | {name, uuid}]}'
```

Expected: um item `{"name": "postgresql", ...}` — o **nome do sub-recurso é o hostname interno** na rede Docker do compose (neste caso, `postgresql`, porta padrão `5432`).

- [ ] **Step 3: Pegar user/senha/database do Postgres na UI do Coolify (a API não devolve isso)**

Pedir pro usuário: abrir o service n8n no Coolify → sub-recurso `postgresql` → aba Environment Variables → revelar e copiar `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Esses 3 valores + host (`postgresql`) + porta (`5432`) são a conexão completa — usada no Task 3 pra criar a credencial Postgres no n8n. Não escrever esses valores em nenhum arquivo do repo.

---

## Task 2: Escrever `sql/schema.sql` (fonte da verdade, idempotente)

**Files:**
- Create: `sql/schema.sql`

- [ ] **Step 1: Criar o arquivo**

```sql
-- sql/schema.sql
CREATE SCHEMA IF NOT EXISTS postador;

CREATE TABLE IF NOT EXISTS postador.niches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  clip_keywords TEXT[],
  voice_id TEXT NOT NULL,
  mascot_image_url TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'manual',
  youtube_made_for_kids BOOLEAN NOT NULL DEFAULT true,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.topics_used (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  topic TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.video_runs (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  status TEXT NOT NULL DEFAULT 'em_progresso',
  current_step TEXT,
  topic TEXT,
  script_text TEXT,
  voice_url TEXT,
  captions_json JSONB,
  assets_json JSONB,
  music_url TEXT,
  render_16x9_url TEXT,
  render_9x16_url TEXT,
  thumbnail_url TEXT,
  youtube_video_id TEXT,
  youtube_shorts_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.costs (
  id SERIAL PRIMARY KEY,
  video_run_id INTEGER NOT NULL REFERENCES postador.video_runs(id),
  step TEXT NOT NULL,
  provider TEXT NOT NULL,
  estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Commit**

```bash
git add sql/schema.sql
git commit -m "docs(sql): add idempotent postador schema DDL"
```

---

## Task 3: Credencial Postgres no n8n + workflow descartável de setup

**Files:**
- Create: `n8n-workflows/db-setup.json`

- [ ] **Step 1: Criar a credencial Postgres via API do n8n**

```bash
N8N_BASE="https://n8n.wm10.info"
N8N_API_KEY="<obter com o operador — não versionar>"
curl -s -X POST "$N8N_BASE/api/v1/credentials" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Postgres postador",
    "type": "postgres",
    "data": {
      "host": "postgresql",
      "port": 5432,
      "database": "<POSTGRES_DB do Task 1>",
      "user": "<POSTGRES_USER do Task 1>",
      "password": "<POSTGRES_PASSWORD do Task 1>",
      "ssl": "disable",
      "allowUnauthorizedCerts": false,
      "sshTunnel": false
    }
  }'
```

Nota: `allowUnauthorizedCerts`/`sshTunnel` são **obrigatórios explicitamente** (`false`) — o schema de validação da credencial `postgres` do n8n tem uma regra condicional mal-comportada: se esses campos vierem ausentes (em vez de `false` explícito), a validação trata como se fossem `true` e exige um monte de campo SSH que não fazem sentido aqui (`sshHost`, `sshPort` etc.), retornando um 400 confuso. Confirmado testando nesta sessão.

Expected: `200`, JSON com `"id"` da credencial criada — anotar como `$PG_CRED_ID` (vai pro arquivo local do Task 5).

- [ ] **Step 2: Escrever `n8n-workflows/db-setup.json`**

```json
{
  "name": "Postador - DB Setup (descartável)",
  "nodes": [
    {
      "parameters": { "rule": { "interval": [{ "field": "days", "daysInterval": 365 }] } },
      "id": "trigger-1",
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [240, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "CREATE SCHEMA IF NOT EXISTS postador;\n\nCREATE TABLE IF NOT EXISTS postador.niches (\n  id SERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  prompt_template TEXT NOT NULL,\n  clip_keywords TEXT[],\n  voice_id TEXT NOT NULL,\n  mascot_image_url TEXT,\n  approval_mode TEXT NOT NULL DEFAULT 'manual',\n  youtube_made_for_kids BOOLEAN NOT NULL DEFAULT true,\n  dry_run BOOLEAN NOT NULL DEFAULT false,\n  is_active BOOLEAN NOT NULL DEFAULT true,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS postador.topics_used (\n  id SERIAL PRIMARY KEY,\n  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),\n  topic TEXT NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS postador.video_runs (\n  id SERIAL PRIMARY KEY,\n  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),\n  status TEXT NOT NULL DEFAULT 'em_progresso',\n  current_step TEXT,\n  topic TEXT,\n  script_text TEXT,\n  voice_url TEXT,\n  captions_json JSONB,\n  assets_json JSONB,\n  music_url TEXT,\n  render_16x9_url TEXT,\n  render_9x16_url TEXT,\n  thumbnail_url TEXT,\n  youtube_video_id TEXT,\n  youtube_shorts_id TEXT,\n  error_message TEXT,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS postador.costs (\n  id SERIAL PRIMARY KEY,\n  video_run_id INTEGER NOT NULL REFERENCES postador.video_runs(id),\n  step TEXT NOT NULL,\n  provider TEXT NOT NULL,\n  estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);"
      },
      "id": "pg-ddl",
      "name": "Run DDL",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "alwaysOutputData": true,
      "credentials": {
        "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" }
      }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.niches (name, prompt_template, clip_keywords, voice_id, approval_mode, youtube_made_for_kids, dry_run, is_active)\nVALUES (\n  'Esquadrão da Gentileza',\n  'Você é o Capitão do Esquadrão da Gentileza, um herói animado e encorajador que ensina boas maneiras para crianças como se fossem superpoderes e missões. Invente você mesmo o tema de uma nova missão (nome curto, ex: Missão Guarda-Brinquedos, Operação Ouvir os Pais, O Superpoder do Por Favor) que ainda NÃO esteja nesta lista de temas já usados: {{used_topics}}. Gere um roteiro curto (cerca de 130-160 palavras, ~60-75 segundos falado) em português do Brasil sobre esse tema novo. Regras: nunca use tom de bronca (nada de não faça X), sempre celebre o poder da criança de deixar todo mundo mais feliz (herois fazem Y). Frases curtas, verbos de ação. Termine sempre celebrando a criança como herói. Responda SOMENTE em JSON, sem markdown: {\"topic\": \"nome curto da missão\", \"script\": \"texto completo do roteiro\"}.',\n  ARRAY['kids playing','family home','children sharing','siblings'],\n  'pt_BR-faber-medium',\n  'manual',\n  true,\n  true,\n  true\n)\nRETURNING id;"
      },
      "id": "pg-seed-niche",
      "name": "Seed niche",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": {
        "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" }
      }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.video_runs (niche_id, status, current_step, topic) VALUES ($1, 'em_progresso', 'setup', 'Missão de Teste') RETURNING id;",
        "additionalFields": { "queryParams": "id" }
      },
      "id": "pg-seed-run",
      "name": "Seed test video_run",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [900, 300],
      "credentials": {
        "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" }
      }
    }
  ],
  "connections": {
    "Schedule Trigger": { "main": [[{ "node": "Run DDL", "type": "main", "index": 0 }]] },
    "Run DDL": { "main": [[{ "node": "Seed niche", "type": "main", "index": 0 }]] },
    "Seed niche": { "main": [[{ "node": "Seed test video_run", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota: usa `Schedule Trigger` (não `Manual Trigger`) porque `mcp__n8n__execute_workflow` só executa workflows com trigger `Schedule Trigger`/`Webhook Trigger`/`Form Trigger`/`Chat Trigger` — confirmado na prática, `Manual Trigger` é rejeitado. O intervalo de 365 dias é só pra ter uma config válida; nunca vai disparar sozinho de verdade porque o workflow vai ficar inativo depois de usado (Step 5). `Run DDL` tem `alwaysOutputData: true` porque DDL pura sem `RETURNING` devolve 0 linhas, o que travaria a cadeia sem essa flag. `Seed test video_run` usa `$1`+`queryParams` (não `{{ }}` direto na query) — confirmado que o node Postgres v1 não avalia expressions dentro do campo `query`, mesmo com prefixo `=`. ⚠️ **`queryParams` em si também não é expression** — é uma string literal separada por vírgula com nomes de campo do item de entrada (`item.json[nome]`), confirmado lendo o código-fonte e na execução real do plano Roteiro/Voz/Legenda. `"queryParams": "id"` (nome puro) é o correto — `"={{$json.id}}"` falharia com `"propertiesString.split is not a function"`.

- [ ] **Step 3: Substituir o placeholder e registrar via API**

```bash
# PowerShell:
(Get-Content n8n-workflows/db-setup.json -Raw) -replace '__PG_CRED_ID__', $env:PG_CRED_ID | Set-Content n8n-workflows/db-setup.json.tmp

curl -s -X POST "$N8N_BASE/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
  --data-binary @n8n-workflows/db-setup.json.tmp
```

Expected: `200`, JSON com `"id"` do workflow criado. Remover o `.tmp` depois (não commitar o arquivo com o ID já resolvido). Anotar o `id` como `$DB_SETUP_ID`.

- [ ] **Step 4: Ativar e executar via MCP**

MCP exige `active: true` além do trigger correto:

```bash
curl -s -X POST "$N8N_BASE/api/v1/workflows/$DB_SETUP_ID/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Usar `mcp__n8n__search_workflows` com query `"DB Setup"` pra achar o id, depois `mcp__n8n__execute_workflow` com esse id (sem `inputs`).

Expected: execução com 3 nodes verdes, saída do último node (`Seed test video_run`) contendo `{"id": <inteiro>}` — esse é o `run_id` de teste. A saída do node `Seed niche` (visível no painel de execução) contém o `niche_id` de teste (deve ser `1`, já que é a primeira linha da tabela). Anotar os dois — vão pro arquivo local do Task 5, usados como `run_id`/`niche_id` reais em todos os testes isolados dos próximos 4 planos.

- [ ] **Step 5: Desativar o workflow (já cumpriu o papel) e commitar**

```bash
curl -s -X POST "$N8N_BASE/api/v1/workflows/$DB_SETUP_ID/deactivate" -H "X-N8N-API-KEY: $N8N_API_KEY"
git add n8n-workflows/db-setup.json
git commit -m "feat(n8n): add disposable workflow to create postador schema and seed MVP niche"
```

---

## Task 4: Env vars de API externa no app n8n (Coolify)

**Files:** nenhum arquivo de código — chamadas de API.

- [ ] **Step 1: Bulk-update das env vars do service n8n**

Valores fornecidos pontualmente pelo usuário no momento da execução — nunca escritos em arquivo. n8n é Coolify **Service** (`$N8N_SERVICE_UUID` do Task 1), não Application — endpoint é `/api/v1/services/{uuid}/...`, não `/api/v1/applications/{uuid}/...`.

```bash
curl -s -X PATCH "$COOLIFY_BASE/api/v1/services/$N8N_SERVICE_UUID/envs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "data": [
      {"key": "OPENROUTER_API_KEY", "value": "<valor>"},
      {"key": "PEXELS_API_KEY", "value": "<valor>"},
      {"key": "PIXABAY_API_KEY", "value": "<valor>"},
      {"key": "TELEGRAM_BOT_TOKEN", "value": "<valor>"},
      {"key": "TELEGRAM_CHAT_ID", "value": "<valor — confirmar que é um chat_id de destino real, não o username do próprio bot>"},
      {"key": "RENDER_AUTH_TOKEN", "value": "<valor já configurado no app render-service>"},
      {"key": "WHISPER_AUTH_TOKEN", "value": "<valor já configurado no app whisper-service>"},
      {"key": "TTS_AUTH_TOKEN", "value": "<valor já configurado no app tts-service>"},
      {"key": "N8N_BLOCK_ENV_ACCESS_IN_NODE", "value": "false"}
    ]
  }'
```

⚠️ **`N8N_BLOCK_ENV_ACCESS_IN_NODE: false` é obrigatório** — confirmado nesta sessão que essa variável já vinha `true` (padrão de segurança do template Coolify), o que bloqueia **qualquer** acesso a `$env.*` dentro de Code/HTTP Request node com o erro `"access to env vars denied"`. Sem isso, toda a convenção de autenticação via `$env` (usada nos 4 próximos planos) não funciona.

Expected: `200`.

- [ ] **Step 2: Restart do service pra aplicar as env vars**

```bash
curl -s -X POST "$COOLIFY_BASE/api/v1/services/$N8N_SERVICE_UUID/restart" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200`, `{"message":"Service restarting request queued."}`. Aguardar `GET /api/v1/services/$N8N_SERVICE_UUID` voltar `"status": "running:healthy"` (pode levar 1-2min).

- [ ] **Step 3: Confirmar que as expressions `$env` funcionam dentro do n8n**

Criar um workflow de teste descartável (`Schedule Trigger` → `Code` node retornando `{ openrouter: $env.OPENROUTER_API_KEY.slice(0,4), ... }` pra cada uma das 8 variáveis — **não** usar `Manual Trigger`, `mcp__n8n__execute_workflow` rejeita esse tipo de trigger). Registrar com `"settings": {"availableInMCP": true}`, ativar (`POST /api/v1/workflows/{id}/activate`), executar via MCP, conferir que nenhum valor vem vazio (só os 4 primeiros caracteres de cada, nunca o valor completo).

Se vier vazio ou o erro for `"access to env vars denied"`: `N8N_BLOCK_ENV_ACCESS_IN_NODE` ainda está `true` — repetir Step 1/2.

Apagar o workflow de teste depois (`DELETE /api/v1/workflows/{id}`).

---

## Task 5: Registrar convenções e IDs desta sessão pros próximos 4 planos

**Files:**
- Modify: `.gitignore`
- Create: `docs/superpowers/plans/n8n-instance.local.md` (não versionado)

- [ ] **Step 1: Adicionar padrão ao `.gitignore`**

```
docs/superpowers/plans/*.local.md
```

- [ ] **Step 2: Escrever o arquivo local de referência**

```markdown
# n8n instance reference (local, não versionado)

- N8N_SERVICE_UUID (Coolify Service, não Application): <valor do Task 1>
- PG_CRED_ID (credencial Postgres no n8n): <valor do Task 3>
- Workflow "Postador - DB Setup" id: <valor do Task 3>
- niche_id de teste (Esquadrão da Gentileza): <valor do Task 3>
- run_id de teste (Missão de Teste): <valor do Task 3>
- Env vars confirmadas no app n8n: OPENROUTER_API_KEY, PEXELS_API_KEY, PIXABAY_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RENDER_AUTH_TOKEN, WHISPER_AUTH_TOKEN, TTS_AUTH_TOKEN
- Credencial YouTube OAuth2 (já existia, criada manualmente na UI): nome exato = <checar em Settings > Credentials na UI do n8n>
```

- [ ] **Step 3: Commit dos artefatos versionáveis**

```bash
git add .gitignore
git commit -m "chore: gitignore local n8n instance reference file"
```

---

## Self-Review

- **Cobertura**: schema Postgres criado + seed do nicho MVP (spec seção "Schema Postgres"), todas as credenciais/env vars listadas na seção "Build e Deploy" do spec (exceto YouTube OAuth2, que já existe) ficam disponíveis pros próximos planos. ✅
- **Sem placeholders de lógica**: DDL completa (idêntica ao spec, com `IF NOT EXISTS`), workflow JSON completo com os 3 nodes e conexões reais. Únicos placeholders são segredos/IDs específicos da instância, com padrão de substituição explícito (`sed`/PowerShell antes do `POST`). ✅
- **Consistência**: contrato `{run_id, niche_id}` e convenção de header `Authorization` via `$env` documentados aqui são reusados literalmente nos 4 próximos planos — não redefinidos diferente em cada um. ✅
- **Risco conhecido**: nomes exatos das env vars `DB_POSTGRESDB_*` no app n8n podem divergir do padrão assumido — Task 1 Step 2 já documenta fallback (procurar por qualquer chave `POSTGRES`/`DB_`). Tipo de credencial genérica do n8n (`httpHeaderAuth`/`httpQueryAuth`) foi deliberadamente evitado por variar entre versões — usamos `$env` em expression no lugar, abordagem estável independente de versão. ✅
