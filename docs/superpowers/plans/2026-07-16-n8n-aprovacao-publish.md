# n8n Aprovação + Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar **Aprovação** (Telegram manual, aprovar/rejeitar antes de publicar) e **Publish** (upload YouTube nos 2 formatos, respeitando `dry_run`). No fim, um `video_runs` de teste aprovado manualmente sai com `youtube_video_id`/`youtube_shorts_id` preenchidos e `status='publicado'`.

**Architecture:** Aprovação usa o node **nativo** `Telegram` do n8n com `operation: sendAndWait` — descoberto nesta sessão lendo o código-fonte do n8n: esse node já resolve envio+espera+webhook+retomada+aprovação-com-um-toque-no-chat internamente (recurso "Human in the Loop" oficial), muito mais robusto que montar isso na mão com node `Wait` + link + query param. Publish usa o node nativo `YouTube` (`resource: video, operation: upload`) — schema exato confirmado lendo `packages/nodes-base/nodes/Google/YouTube/VideoDescription.ts` do repositório oficial do n8n nesta sessão, não adivinhado.

**Tech Stack:** node `n8n-nodes-base.telegram` (`sendPhoto` + `sendAndWait`), node `n8n-nodes-base.youTube` (`video`/`upload`), node `n8n-nodes-base.httpRequest` (download binário pra upload), node `n8n-nodes-base.if` (v2 filter).

**Pré-requisito:** Planos anteriores executados — `run_id` de teste tem `script_text`, `voice_url`, `captions_json`, `assets_json`, `music_url`, `render_16x9_url`, `render_9x16_url`, `thumbnail_url` preenchidos. Credencial YouTube OAuth2 já existe (criada manualmente na UI, conforme `CLAUDE.md`).

**Exceção à convenção do plano de fundações:** Aprovação precisa de uma credencial `telegramApi` de verdade (não `$env` cru) — o mecanismo de aprovação-com-um-toque do node Telegram deriva um token secreto de validação do webhook a partir do `accessToken` da credencial (confirmado lendo `Telegram/hitl/webhook.ts`), então não dá pra contornar com header manual.

## Achados da execução do plano de fundações e do plano Roteiro/Voz/Legenda (aplicar em todo registro/teste deste plano)

- **`⚠️ TELEGRAM_CHAT_ID`**: já corrigido em 2026-07-17 pra um chat_id numérico real (`1241187505`) — o valor inicial coletado era o username do próprio bot. Nada a fazer aqui, só não reverter.
- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos.
- **Ativar workflow é `POST /api/v1/workflows/{id}/activate`** (endpoint dedicado, não `PATCH` no workflow em si).
- **`mcp__n8n__execute_workflow` só executa workflows com trigger `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`** — `Execute Workflow Trigger` não está nessa lista, e precisa `active: true` + `settings.availableInMCP: true`. Cada workflow deste plano já nasce com `"settings": {"availableInMCP": true}`.
- **Procedimento de Teste Isolado via MCP**: trocar temporariamente o `Execute Workflow Trigger` por `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste, testar, restaurar depois. ⚠️ **O Code node de substituição precisa manter o nome exato `"Execute Workflow Trigger"`** — qualquer node adiante que referencie `$node["Execute Workflow Trigger"]` quebra com `"Referenced node doesn't exist"` se o node de teste tiver outro nome.

```bash
# $N8N_BASE, $N8N_API_KEY já setados. $WORKFLOW_ID = id do sub-workflow. $TEST_RUN_ID/$TEST_NICHE_ID de n8n-instance.local.md.
curl -s "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/wf-live.json

jq --arg runId "$TEST_RUN_ID" --arg nicheId "$TEST_NICHE_ID" '
  .nodes = ([
    {"parameters":{"rule":{"interval":[{"field":"days","daysInterval":365}]}},"id":"test-trigger","name":"Test Trigger Source","type":"n8n-nodes-base.scheduleTrigger","typeVersion":1.2,"position":[0,600]},
    {"parameters":{"mode":"runOnceForAllItems","jsCode":("return [{ json: { run_id: " + $runId + ", niche_id: " + $nicheId + " } }];")},"id":"test-input","name":"Execute Workflow Trigger","type":"n8n-nodes-base.code","typeVersion":2,"position":[120,600]}
  ] + (.nodes | map(select(.name != "Execute Workflow Trigger")))) |
  .connections["Test Trigger Source"] = {"main": [[{"node":"Execute Workflow Trigger","type":"main","index":0}]]} |
  {name, nodes, connections, settings}
' /tmp/wf-live.json > /tmp/wf-test.json

curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-test.json
```

Executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $WORKFLOW_ID`, sem `inputs`). Depois, restaurar:

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-live.json
```

- ⚠️ **`additionalFields.queryParams` do node Postgres NÃO é uma expression `{{ }}`** — confirmado lendo `nodes-base/nodes/Postgres/v1/genericFunctions.ts`: é uma string literal separada por vírgula com **nomes de campo do item de entrada atual** (`item.json[nome]`). O plano original usava `"={{$json.niche_id}}"`/`"={{$node[...]...}}"` — **errado**, falha com `"propertiesString.split is not a function"` ou lê o campo errado. Correto: nome puro (ex. `"run_id"`), e **nunca** referenciando outro node — só o item imediatamente anterior. Consequências aplicadas nos JSONs abaixo:
  - Onde o valor vem de 2 tabelas diferentes (`video_runs` + `niches`), 1 query com `JOIN` substitui os 2 reads separados.
  - Onde o valor "atravessa" o node `Telegram`/`YouTube`/HTTP (que retornam um item novo, sem os campos antigos), um Code node logo antes da escrita Postgres remonta um item plano com exatamente os nomes citados em `queryParams`, puxando de `$node[...]` (Code node pode referenciar qualquer node livremente).
  - A saída do node `Telegram` `sendAndWait` vem **aninhada** em `$json.data.approved` (não `$json.approved`) — outro motivo pra precisar de um Code node antes de gravar no Postgres.
- **HTTP Request/Code/IF/YouTube nodes NÃO têm essa restrição** — `{{ }}` e `$node["..."]` funcionam normalmente neles. Só `additionalFields.queryParams` do Postgres é especial.

---

## Task 1: Credencial Telegram + segurança do webhook de aprovação

**Files:** nenhum arquivo de código — chamada de API.

- [x] **Step 1: Criar a credencial Telegram via API do n8n**

**Concluído em 2026-07-18, com desvio**: feito via UI (Settings → Credentials → Add), não via `curl`/API key — evita expor a API key na conversa. `id = RMJkbhcAQmxSNFoK`.

```bash
N8N_BASE="https://n8n.wm10.info"
N8N_API_KEY="<obter com o operador — não versionar>"
curl -s -X POST "$N8N_BASE/api/v1/credentials" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Telegram Postador",
    "type": "telegramApi",
    "data": { "accessToken": "<TELEGRAM_BOT_TOKEN>" }
  }'
```

Expected: `200`, JSON com `id` — anotar como `$TG_CRED_ID` em `n8n-instance.local.md`.

- [ ] **Step 2: Confirmar que o n8n está acessível por HTTPS público**

O recurso "Approve Within Chat" (um toque direto no chat, em vez de abrir link no navegador) **exige** que este n8n seja alcançável por HTTPS público — já é o caso (`https://n8n.wm10.info`, confirmado no contexto do plano de fundações). Nenhuma ação necessária, só documentando a dependência.

- [ ] **Step 3: Localizar o id da credencial YouTube OAuth2 já existente**

```bash
curl -s "$N8N_BASE/api/v1/credentials/schema/youTubeOAuth2Api" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Se esse endpoint não listar credenciais existentes (a API pública do n8n geralmente não expõe `data` nem lista todas por tipo facilmente), abrir a UI do n8n → Settings → Credentials → localizar a credencial YouTube já criada manualmente → copiar seu `id` pela URL da página de edição. Anotar como `$YOUTUBE_CRED_ID` e o nome exato em `n8n-instance.local.md`.

---

## Task 2: Sub-workflow Aprovação

**Files:**
- Create: `n8n-workflows/aprovacao.json`

- [ ] **Step 1: Escrever `n8n-workflows/aprovacao.json`**

```json
{
  "name": "Postador - Aprovação",
  "nodes": [
    {
      "parameters": {},
      "id": "trigger-1",
      "name": "Execute Workflow Trigger",
      "type": "n8n-nodes-base.executeWorkflowTrigger",
      "typeVersion": 1,
      "position": [240, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT vr.id AS run_id, vr.topic, vr.script_text, vr.thumbnail_url, vr.render_16x9_url, n.approval_mode FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-read-run",
      "name": "Read run and niche for approval",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-manual",
              "leftValue": "={{$json.approval_mode}}",
              "rightValue": "manual",
              "operator": { "type": "string", "operation": "equals" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-manual",
      "name": "Is manual approval?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [680, 300]
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "sendPhoto",
        "chatId": "={{$env.TELEGRAM_CHAT_ID}}",
        "binaryData": false,
        "file": "={{$json.thumbnail_url}}",
        "additionalFields": { "caption": "={{$json.topic}}" }
      },
      "id": "tg-send-photo",
      "name": "Send thumbnail preview",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1.2,
      "position": [900, 200],
      "credentials": { "telegramApi": { "id": "__TG_CRED_ID__", "name": "Telegram Postador" } }
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "sendAndWait",
        "chatId": "={{$env.TELEGRAM_CHAT_ID}}",
        "subject": "=Aprovação de vídeo — {{$node[\"Read run and niche for approval\"].json.topic}}",
        "message": "=Tema: {{$node[\"Read run and niche for approval\"].json.topic}}\n\nTrecho do roteiro:\n{{$node[\"Read run and niche for approval\"].json.script_text.slice(0,300)}}...\n\nVídeo (16:9): {{$node[\"Read run and niche for approval\"].json.render_16x9_url}}",
        "responseType": "approval",
        "approvalOptions": {
          "values": { "approvalType": "double", "approveLabel": "Aprovar", "disapproveLabel": "Rejeitar" }
        },
        "chatApproval": true,
        "chatApprovalOptions": {},
        "options": {}
      },
      "id": "tg-send-and-wait",
      "name": "Send approval request",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1.2,
      "position": [1120, 200],
      "credentials": { "telegramApi": { "id": "__TG_CRED_ID__", "name": "Telegram Postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { approved: $json.data.approved, run_id: $node[\"Execute Workflow Trigger\"].json.run_id } }];"
      },
      "id": "code-flatten-decision",
      "name": "Flatten decision",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 200]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET status = CASE WHEN $1::boolean THEN 'aprovado' ELSE 'rejeitado' END, current_step = 'aprovacao', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "approved,run_id" }
      },
      "id": "pg-update-manual",
      "name": "Save manual decision",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 200],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET status = 'aprovado', current_step = 'aprovacao', updated_at = now() WHERE id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-update-auto",
      "name": "Save auto approval",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [900, 420],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read run and niche for approval", "type": "main", "index": 0 }]] },
    "Read run and niche for approval": { "main": [[{ "node": "Is manual approval?", "type": "main", "index": 0 }]] },
    "Is manual approval?": {
      "main": [
        [{ "node": "Send thumbnail preview", "type": "main", "index": 0 }],
        [{ "node": "Save auto approval", "type": "main", "index": 0 }]
      ]
    },
    "Send thumbnail preview": { "main": [[{ "node": "Send approval request", "type": "main", "index": 0 }]] },
    "Send approval request": { "main": [[{ "node": "Flatten decision", "type": "main", "index": 0 }]] },
    "Flatten decision": { "main": [[{ "node": "Save manual decision", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota de design: `Read run and niche for approval` faz **1 query com `JOIN`** (video_runs + niches) em vez de 2 nodes separados — evita o problema de `queryParams` só enxergar campos do item atual. `Flatten decision` existe porque `Send approval request` devolve o resultado aninhado em `$json.data.approved` (não `$json.approved`), e porque `run_id` precisa ser reintroduzido no item (a query original não tinha por onde carregá-lo até aqui sem esse node).

- [x] **Step 2: Substituir placeholders e registrar via API**

**Concluído em 2026-07-18, com desvio**: registrado via **Import from File** na UI do n8n (`n8n-workflows/aprovacao.json` como está, com placeholders) em vez de `curl`+API key. Depois do import, cada node com credencial faltando foi resolvido escolhendo no dropdown da UI (Postgres postador / Telegram Postador) — não precisou substituir os placeholders no arquivo. `id = UtqBinFZ1gQ3IyVz`. Ativado via toggle "Active" na UI.

- [x] **Step 3: Testar isolado**

**Concluído em 2026-07-19, com desvio**: o "Procedimento de Teste Isolado via MCP" **não se aplicou** — a UI do n8n recusa ligar `settings.availableInMCP` pra workflow com `Execute Workflow Trigger` (erro "Error updating MCP settings..."), então o workflow importado via UI não aparece nem em `search_workflows` nem em `get_workflow_details` do MCP (ver Achado 6 em `n8n-instance.local.md`). Teste feito **direto na UI**: clicar no node "Execute Workflow Trigger" → colar `{"run_id": 1, "niche_id": 1}` no painel de teste → "Test workflow".

A execução **pausou** no node "Send approval request" como esperado — chegaram as 2 mensagens no Telegram (foto+legenda, depois pergunta com botões "Aprovar"/"Rejeitar" tocáveis no chat). Tocado "Aprovar" → execução retomou, node "Save manual decision" verde no painel (sem erro) → `video_runs.status` confirmado `'aprovado'`.

**Teste de rejeição pulado** (decisão consciente, não esquecimento): exigiria um `run_id` novo (rodar Roteiro→Voz→Legenda→Assets→Render de novo só pra isso), e a lógica é um `CASE WHEN approved THEN 'aprovado' ELSE 'rejeitado'` trivial — risco baixo o suficiente pra pular num projeto pessoal.

- [x] **Step 4: Commit**

```bash
git add n8n-workflows/aprovacao.json
git commit -m "feat(n8n): add Aprovação sub-workflow (Telegram native sendAndWait, one-tap in-chat approval)"
```

---

## Task 3: Sub-workflow Publish

**Files:**
- Create: `n8n-workflows/publish.json`

**Nota de segurança:** o node YouTube abaixo tem `privacyStatus` default **`private`** — publicar como `public`/`unlisted` de verdade é uma ação visível externamente e difícil de desfazer por completo (mesmo apagando depois, pode ter sido indexado). Trocar pra `public` deliberadamente só quando estiver pronto pra publicar de verdade, depois de validar com `dry_run=true` e/ou `privacyStatus=private` primeiro.

- [ ] **Step 1: Escrever `n8n-workflows/publish.json`**

```json
{
  "name": "Postador - Publish",
  "nodes": [
    {
      "parameters": {},
      "id": "trigger-1",
      "name": "Execute Workflow Trigger",
      "type": "n8n-nodes-base.executeWorkflowTrigger",
      "typeVersion": 1,
      "position": [240, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT vr.id AS run_id, vr.status, vr.render_16x9_url, vr.render_9x16_url, vr.topic, vr.script_text, n.youtube_made_for_kids, n.dry_run FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-read-run",
      "name": "Read run and niche for publish",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-approved",
              "leftValue": "={{$json.status}}",
              "rightValue": "aprovado",
              "operator": { "type": "string", "operation": "equals" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-approved",
      "name": "Is approved?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [680, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET current_step = 'publish_skipped', updated_at = now() WHERE id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-skip",
      "name": "Mark publish skipped",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [900, 460],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-dry-run",
              "leftValue": "={{$json.dry_run}}",
              "rightValue": true,
              "operator": { "type": "boolean", "operation": "equals" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-dry-run",
      "name": "Is dry run?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [900, 220]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET current_step = 'dry_run_stop', updated_at = now() WHERE id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-dry-stop",
      "name": "Mark dry-run stop",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 140],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "={{$node[\"Read run and niche for publish\"].json.render_16x9_url}}",
        "options": { "response": { "response": { "responseFormat": "file", "outputPropertyName": "data" } } }
      },
      "id": "http-download-16x9",
      "name": "Download render 16:9",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "resource": "video",
        "operation": "upload",
        "title": "={{$node[\"Read run and niche for publish\"].json.topic}}",
        "regionCode": "BR",
        "categoryId": "27",
        "binaryProperty": "data",
        "options": {
          "description": "={{$node[\"Read run and niche for publish\"].json.script_text}}",
          "privacyStatus": "private",
          "selfDeclaredMadeForKids": "={{$node[\"Read run and niche for publish\"].json.youtube_made_for_kids}}",
          "notifySubscribers": false
        }
      },
      "id": "youtube-upload-16x9",
      "name": "Upload 16:9 to YouTube",
      "type": "n8n-nodes-base.youTube",
      "typeVersion": 1,
      "position": [1340, 300],
      "credentials": { "youTubeOAuth2Api": { "id": "__YOUTUBE_CRED_ID__", "name": "__YOUTUBE_CRED_NAME__" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { videoId16x9: $json.id } }];"
      },
      "id": "code-extract-16x9-id",
      "name": "Extract 16x9 video id",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1560, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "={{$node[\"Read run and niche for publish\"].json.render_9x16_url}}",
        "options": { "response": { "response": { "responseFormat": "file", "outputPropertyName": "data" } } }
      },
      "id": "http-download-9x16",
      "name": "Download render 9:16",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1780, 300]
    },
    {
      "parameters": {
        "resource": "video",
        "operation": "upload",
        "title": "={{$node[\"Read run and niche for publish\"].json.topic}} #Shorts",
        "regionCode": "BR",
        "categoryId": "27",
        "binaryProperty": "data",
        "options": {
          "description": "={{$node[\"Read run and niche for publish\"].json.script_text}}",
          "privacyStatus": "private",
          "selfDeclaredMadeForKids": "={{$node[\"Read run and niche for publish\"].json.youtube_made_for_kids}}",
          "notifySubscribers": false
        }
      },
      "id": "youtube-upload-9x16",
      "name": "Upload 9:16 to YouTube",
      "type": "n8n-nodes-base.youTube",
      "typeVersion": 1,
      "position": [2000, 300],
      "credentials": { "youTubeOAuth2Api": { "id": "__YOUTUBE_CRED_ID__", "name": "__YOUTUBE_CRED_NAME__" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { videoId16x9: $node[\"Extract 16x9 video id\"].json.videoId16x9, videoId9x16: $json.id, run_id: $node[\"Read run and niche for publish\"].json.run_id } }];"
      },
      "id": "code-extract-9x16-id",
      "name": "Extract 9x16 video id",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2220, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET youtube_video_id = $1, youtube_shorts_id = $2, status = 'publicado', current_step = 'publish', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "videoId16x9,videoId9x16,run_id" }
      },
      "id": "pg-save-publish",
      "name": "Save publish results",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [2440, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read run and niche for publish", "type": "main", "index": 0 }]] },
    "Read run and niche for publish": { "main": [[{ "node": "Is approved?", "type": "main", "index": 0 }]] },
    "Is approved?": {
      "main": [
        [{ "node": "Is dry run?", "type": "main", "index": 0 }],
        [{ "node": "Mark publish skipped", "type": "main", "index": 0 }]
      ]
    },
    "Is dry run?": {
      "main": [
        [{ "node": "Mark dry-run stop", "type": "main", "index": 0 }],
        [{ "node": "Download render 16:9", "type": "main", "index": 0 }]
      ]
    },
    "Download render 16:9": { "main": [[{ "node": "Upload 16:9 to YouTube", "type": "main", "index": 0 }]] },
    "Upload 16:9 to YouTube": { "main": [[{ "node": "Extract 16x9 video id", "type": "main", "index": 0 }]] },
    "Extract 16x9 video id": { "main": [[{ "node": "Download render 9:16", "type": "main", "index": 0 }]] },
    "Download render 9:16": { "main": [[{ "node": "Upload 9:16 to YouTube", "type": "main", "index": 0 }]] },
    "Upload 9:16 to YouTube": { "main": [[{ "node": "Extract 9x16 video id", "type": "main", "index": 0 }]] },
    "Extract 9x16 video id": { "main": [[{ "node": "Save publish results", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota de design: `Read run and niche for publish` faz **1 query com `JOIN`** (video_runs + niches) — todo IF/HTTP/YouTube node adiante referencia esse node diretamente por `$node[...]` (permitido, só `queryParams` de Postgres não permite). `Extract 9x16 video id` é o único ponto que precisa remontar um item plano (`videoId16x9` + `videoId9x16` + `run_id`) pra alimentar `queryParams` do `Save publish results`.

- [x] **Step 2: Substituir placeholders e registrar via API**

**Concluído em 2026-07-18, com desvio** (mesmo padrão do Aprovação Task 2 Step 2): importado via UI (Import from File), credenciais Postgres/YouTube resolvidas via dropdown na UI. `id = 5ThN6VyUOGCWVvWF`. Ativado via toggle.

- [x] **Step 3: Testar isolado com `dry_run=true` primeiro (seed já tem isso como default)**

**Concluído em 2026-07-19, com desvio**: teste direto na UI (mesmo motivo do Aprovação — workflow invisível ao MCP), colando `{"run_id": 1, "niche_id": 1}` no node trigger e "Test workflow". Confirmado: caminho `Is dry run?` → TRUE → `Mark dry-run stop`, nodes de upload YouTube **não executados** (cinza no painel).

- [x] **Step 4: Testar publish real (opcional, só quando quiser validar o upload de verdade)**

**Feito em 2026-07-19** (usuário optou por validar agora em vez de adiar). `dry_run` setado `false` via `psql` direto no Terminal do serviço `postgresql` no Coolify (sem acesso via API/n8n pra isso). Rodado de novo o mesmo teste na UI — os 2 uploads aconteceram de verdade, confirmados **privados** no YouTube Studio. `dry_run` revertido pra `true` logo depois, confirmado pelo usuário.

- [x] **Step 5: Commit**

```bash
git add n8n-workflows/publish.json
git commit -m "feat(n8n): add Publish sub-workflow (YouTube upload 16:9 + Shorts, dry_run gate, private by default)"
```

---

## Self-Review

- **Cobertura**: itens 6-7 da seção "Arquitetura de Workflows" do spec (Aprovação, Publish), incluindo os 2 modos de aprovação (`manual`/`auto`) e o gate `dry_run` antes de qualquer chamada real ao YouTube. ✅
- **Sem placeholders de lógica**: todo Code/IF/query é literal e completo. Únicos placeholders são segredo/instância (`__PG_CRED_ID__`, `__TG_CRED_ID__`, `__YOUTUBE_CRED_ID__`/`__YOUTUBE_CRED_NAME__`). ✅
- **Risco verificado, não adivinhado**: os 2 pontos de maior incerteza do pipeline inteiro (schema exato do node YouTube, mecanismo de aprovação via Telegram) foram checados lendo o **código-fonte oficial do n8n no GitHub** nesta sessão (`VideoDescription.ts`, `Telegram.node.ts`, `hitl/webhook.ts`, `sendAndWait/utils.ts`), não estimados de memória. O bug de `queryParams` (encontrado executando o plano Roteiro/Voz/Legenda) também foi corrigido aqui **antes** da primeira execução real deste plano, não depois. ✅
- **Segurança**: `privacyStatus: 'private'` como default deliberado — publicar publicamente é ação externa difícil de desfazer, fica como troca manual e consciente (documentada no Step 4), não um default que expõe conteúdo sem confirmação explícita. ✅
- **Consistência**: `run_id` sempre disponível via a query `JOIN` inicial de cada workflow (coluna `vr.id AS run_id`), carregado adiante por Code nodes quando uma chamada HTTP/Telegram/YouTube "quebra" a cadeia de campos; `queryParams` de todo node Postgres usa só nomes de campo do item imediatamente anterior. Nomes de coluna (`status`, `current_step`, `youtube_video_id`, `youtube_shorts_id`) batem com o schema do plano de fundações. ✅
