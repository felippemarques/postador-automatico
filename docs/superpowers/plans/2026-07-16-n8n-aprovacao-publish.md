# n8n Aprovação + Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar **Aprovação** (Telegram manual, aprovar/rejeitar antes de publicar) e **Publish** (upload YouTube nos 2 formatos, respeitando `dry_run`). No fim, um `video_runs` de teste aprovado manualmente sai com `youtube_video_id`/`youtube_shorts_id` preenchidos e `status='publicado'`.

**Architecture:** Aprovação usa o node **nativo** `Telegram` do n8n com `operation: sendAndWait` — descoberto nesta sessão lendo o código-fonte do n8n: esse node já resolve envio+espera+webhook+retomada+aprovação-com-um-toque-no-chat internamente (recurso "Human in the Loop" oficial), muito mais robusto que montar isso na mão com node `Wait` + link + query param. Publish usa o node nativo `YouTube` (`resource: video, operation: upload`) — schema exato confirmado lendo `packages/nodes-base/nodes/Google/YouTube/VideoDescription.ts` do repositório oficial do n8n nesta sessão, não adivinhado.

**Tech Stack:** node `n8n-nodes-base.telegram` (`sendPhoto` + `sendAndWait`), node `n8n-nodes-base.youTube` (`video`/`upload`), node `n8n-nodes-base.httpRequest` (download binário pra upload), node `n8n-nodes-base.if` (v2 filter).

**Pré-requisito:** Planos anteriores executados — `run_id` de teste tem `script_text`, `voice_url`, `captions_json`, `assets_json`, `music_url`, `render_16x9_url`, `render_9x16_url`, `thumbnail_url` preenchidos. Credencial YouTube OAuth2 já existe (criada manualmente na UI, conforme `CLAUDE.md`).

**Exceção à convenção do plano de fundações:** Aprovação precisa de uma credencial `telegramApi` de verdade (não `$env` cru) — o mecanismo de aprovação-com-um-toque do node Telegram deriva um token secreto de validação do webhook a partir do `accessToken` da credencial (confirmado lendo `Telegram/hitl/webhook.ts`), então não dá pra contornar com header manual.

## Achados da execução do plano de fundações (aplicar em todo registro/teste deste plano)

- **`⚠️ TELEGRAM_CHAT_ID` verificar antes de começar**: no plano de fundações, o valor coletado (`@lekrgjeruitghubot`) parecia ser o username do próprio bot, não um chat_id de destino — confirmar/corrigir antes do Task 2 (senão `Send thumbnail preview`/`Send approval request` vão falhar ou mandar mensagem pro lugar errado).
- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos.
- **Ativar workflow é `POST /api/v1/workflows/{id}/activate`** (endpoint dedicado, não `PATCH` no workflow em si).
- **`mcp__n8n__execute_workflow` só executa workflows com trigger `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`** — `Execute Workflow Trigger` não está nessa lista, e precisa `active: true` + `settings.availableInMCP: true`. Cada workflow deste plano já nasce com `"settings": {"availableInMCP": true}`.
- **Procedimento de Teste Isolado via MCP**: trocar temporariamente o `Execute Workflow Trigger` por `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste, testar, restaurar depois.

```bash
# $N8N_BASE, $N8N_API_KEY já setados. $WORKFLOW_ID = id do sub-workflow. $TEST_RUN_ID/$TEST_NICHE_ID de n8n-instance.local.md.
curl -s "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/wf-live.json

jq --arg runId "$TEST_RUN_ID" --arg nicheId "$TEST_NICHE_ID" '
  .nodes = ([
    {"parameters":{"rule":{"interval":[{"field":"days","daysInterval":365}]}},"id":"test-trigger","name":"Test Trigger","type":"n8n-nodes-base.scheduleTrigger","typeVersion":1.2,"position":[0,600]},
    {"parameters":{"mode":"runOnceForAllItems","jsCode":("return [{ json: { run_id: " + $runId + ", niche_id: " + $nicheId + " } }];")},"id":"test-input","name":"Test Input","type":"n8n-nodes-base.code","typeVersion":2,"position":[120,600]}
  ] + (.nodes | map(select(.name != "Execute Workflow Trigger")))) |
  .connections["Test Trigger"] = {"main": [[{"node":"Test Input","type":"main","index":0}]]} |
  .connections["Test Input"] = .connections["Execute Workflow Trigger"] |
  del(.connections["Execute Workflow Trigger"]) |
  {name, nodes, connections, settings}
' /tmp/wf-live.json > /tmp/wf-test.json

curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-test.json
```

Executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $WORKFLOW_ID`, sem `inputs`). Depois, restaurar:

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-live.json
```

- **Node Postgres não avalia `{{ }}` no campo `query`**, mesmo com `=` — este plano já usa só `$1`+`additionalFields.queryParams`, não alterar.

---

## Task 1: Credencial Telegram + segurança do webhook de aprovação

**Files:** nenhum arquivo de código — chamada de API.

- [ ] **Step 1: Criar a credencial Telegram via API do n8n**

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
        "query": "SELECT approval_mode FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$json.niche_id}}" }
      },
      "id": "pg-read-niche",
      "name": "Read niche approval config",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT topic, script_text, thumbnail_url, render_16x9_url FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-read-run",
      "name": "Read run for approval",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-manual",
              "leftValue": "={{$node[\"Read niche approval config\"].json.approval_mode}}",
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
      "position": [900, 300]
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "sendPhoto",
        "chatId": "={{$env.TELEGRAM_CHAT_ID}}",
        "binaryData": false,
        "file": "={{$node[\"Read run for approval\"].json.thumbnail_url}}",
        "additionalFields": { "caption": "={{$node[\"Read run for approval\"].json.topic}}" }
      },
      "id": "tg-send-photo",
      "name": "Send thumbnail preview",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1.2,
      "position": [1120, 200],
      "credentials": { "telegramApi": { "id": "__TG_CRED_ID__", "name": "Telegram Postador" } }
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "sendAndWait",
        "chatId": "={{$env.TELEGRAM_CHAT_ID}}",
        "subject": "=Aprovação de vídeo — {{$node[\"Read run for approval\"].json.topic}}",
        "message": "=Tema: {{$node[\"Read run for approval\"].json.topic}}\n\nTrecho do roteiro:\n{{$node[\"Read run for approval\"].json.script_text.slice(0,300)}}...\n\nVídeo (16:9): {{$node[\"Read run for approval\"].json.render_16x9_url}}",
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
      "position": [1340, 200],
      "credentials": { "telegramApi": { "id": "__TG_CRED_ID__", "name": "Telegram Postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET status = CASE WHEN $1::boolean THEN 'aprovado' ELSE 'rejeitado' END, current_step = 'aprovacao', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "={{$json.data.approved}},{{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
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
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-update-auto",
      "name": "Save auto approval",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 420],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read niche approval config", "type": "main", "index": 0 }]] },
    "Read niche approval config": { "main": [[{ "node": "Read run for approval", "type": "main", "index": 0 }]] },
    "Read run for approval": { "main": [[{ "node": "Is manual approval?", "type": "main", "index": 0 }]] },
    "Is manual approval?": {
      "main": [
        [{ "node": "Send thumbnail preview", "type": "main", "index": 0 }],
        [{ "node": "Save auto approval", "type": "main", "index": 0 }]
      ]
    },
    "Send thumbnail preview": { "main": [[{ "node": "Send approval request", "type": "main", "index": 0 }]] },
    "Send approval request": { "main": [[{ "node": "Save manual decision", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Substituir placeholders e registrar via API**

```bash
(Get-Content n8n-workflows/aprovacao.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID -replace '__TG_CRED_ID__', $TG_CRED_ID | Set-Content n8n-workflows/aprovacao.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/aprovacao.json.tmp
```

Expected: `200` com `id` — anotar em `n8n-instance.local.md` como `$APROVACAO_ID`. **Ativar** (`POST /api/v1/workflows/$APROVACAO_ID/activate` — é `POST` num endpoint dedicado, não `PATCH` no workflow; `PATCH /api/v1/workflows/{id}` genérico retorna 405 nesta instância, confirmado na execução do plano de fundações). Ativação é necessária tanto pro teste isolado via MCP quanto pro webhook de retomada do `sendAndWait` funcionar de verdade.

- [ ] **Step 3: Testar isolado**

Aplicar o "Procedimento de Teste Isolado via MCP" (ver `2026-07-16-n8n-foundations.md`/`n8n-instance.local.md` — trocar `Execute Workflow Trigger` por `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste) com `WORKFLOW_ID=$APROVACAO_ID`, executar via MCP com o nicho de teste (já tem `approval_mode='manual'` do seed).

⚠️ Nota de risco: o webhook de retomada do `sendAndWait` é criado dinamicamente por execução (diferente do webhook estático que falhou ao registrar no plano de fundações), mas a mesma topologia main/worker separada do Coolify pode afetá-lo também — se a execução não retomar depois de tocar no botão do Telegram, checar os logs do processo `n8n`/`n8n-worker` no Coolify antes de assumir que é bug de configuração do workflow.

A execução deve **pausar** no node `Send approval request` — verificar no Telegram configurado (`TELEGRAM_CHAT_ID`) que chegaram 2 mensagens: a foto da thumbnail com legenda, e a pergunta de aprovação com botões "Aprovar"/"Rejeitar" tocáveis direto no chat (não um link). Tocar "Aprovar".

Expected: a execução retoma automaticamente, `video_runs.status` vira `'aprovado'`. Rodar de novo com um novo `run_id` de teste (reaproveitar o mesmo run vai falhar a leitura de `thumbnail_url` se ele já tiver sido sobrescrito por outro teste — usar um `run_id` fresco se disponível) e tocar "Rejeitar" dessa vez, confirmar `status='rejeitado'`.

Se as mensagens não chegarem: checar `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` no env do n8n (Task 4 do plano de fundações) e o `accessToken` da credencial `telegramApi` (Task 1 deste plano).

- [ ] **Step 4: Commit**

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
        "query": "SELECT status, render_16x9_url, render_9x16_url, topic, script_text FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$json.run_id}}" }
      },
      "id": "pg-read-run",
      "name": "Read run for publish",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT youtube_made_for_kids, dry_run FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.niche_id}}" }
      },
      "id": "pg-read-niche",
      "name": "Read niche for publish",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-approved",
              "leftValue": "={{$node[\"Read run for publish\"].json.status}}",
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
      "position": [900, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET current_step = 'publish_skipped', updated_at = now() WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-skip",
      "name": "Mark publish skipped",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 460],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-dry-run",
              "leftValue": "={{$node[\"Read niche for publish\"].json.dry_run}}",
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
      "position": [1120, 220]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET current_step = 'dry_run_stop', updated_at = now() WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-dry-stop",
      "name": "Mark dry-run stop",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1340, 140],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "={{$node[\"Read run for publish\"].json.render_16x9_url}}",
        "options": { "response": { "response": { "responseFormat": "file", "outputPropertyName": "data" } } }
      },
      "id": "http-download-16x9",
      "name": "Download render 16:9",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1340, 300]
    },
    {
      "parameters": {
        "resource": "video",
        "operation": "upload",
        "title": "={{$node[\"Read run for publish\"].json.topic}}",
        "regionCode": "BR",
        "categoryId": "27",
        "binaryProperty": "data",
        "options": {
          "description": "={{$node[\"Read run for publish\"].json.script_text}}",
          "privacyStatus": "private",
          "selfDeclaredMadeForKids": "={{$node[\"Read niche for publish\"].json.youtube_made_for_kids}}",
          "notifySubscribers": false
        }
      },
      "id": "youtube-upload-16x9",
      "name": "Upload 16:9 to YouTube",
      "type": "n8n-nodes-base.youTube",
      "typeVersion": 1,
      "position": [1560, 300],
      "credentials": { "youTubeOAuth2Api": { "id": "__YOUTUBE_CRED_ID__", "name": "__YOUTUBE_CRED_NAME__" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { videoId: $json.id } }];"
      },
      "id": "code-extract-16x9-id",
      "name": "Extract 16x9 video id",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1780, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "={{$node[\"Read run for publish\"].json.render_9x16_url}}",
        "options": { "response": { "response": { "responseFormat": "file", "outputPropertyName": "data" } } }
      },
      "id": "http-download-9x16",
      "name": "Download render 9:16",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [2000, 300]
    },
    {
      "parameters": {
        "resource": "video",
        "operation": "upload",
        "title": "={{$node[\"Read run for publish\"].json.topic}} #Shorts",
        "regionCode": "BR",
        "categoryId": "27",
        "binaryProperty": "data",
        "options": {
          "description": "={{$node[\"Read run for publish\"].json.script_text}}",
          "privacyStatus": "private",
          "selfDeclaredMadeForKids": "={{$node[\"Read niche for publish\"].json.youtube_made_for_kids}}",
          "notifySubscribers": false
        }
      },
      "id": "youtube-upload-9x16",
      "name": "Upload 9:16 to YouTube",
      "type": "n8n-nodes-base.youTube",
      "typeVersion": 1,
      "position": [2220, 300],
      "credentials": { "youTubeOAuth2Api": { "id": "__YOUTUBE_CRED_ID__", "name": "__YOUTUBE_CRED_NAME__" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { videoId: $json.id } }];"
      },
      "id": "code-extract-9x16-id",
      "name": "Extract 9x16 video id",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2440, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET youtube_video_id = $1, youtube_shorts_id = $2, status = 'publicado', current_step = 'publish', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "={{$node[\"Extract 16x9 video id\"].json.videoId}},{{$node[\"Extract 9x16 video id\"].json.videoId}},{{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-save-publish",
      "name": "Save publish results",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [2660, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read run for publish", "type": "main", "index": 0 }]] },
    "Read run for publish": { "main": [[{ "node": "Read niche for publish", "type": "main", "index": 0 }]] },
    "Read niche for publish": { "main": [[{ "node": "Is approved?", "type": "main", "index": 0 }]] },
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

- [ ] **Step 2: Substituir placeholders e registrar via API**

```bash
(Get-Content n8n-workflows/publish.json -Raw) `
  -replace '__PG_CRED_ID__', $PG_CRED_ID `
  -replace '__YOUTUBE_CRED_ID__', $YOUTUBE_CRED_ID `
  -replace '__YOUTUBE_CRED_NAME__', $YOUTUBE_CRED_NAME `
  | Set-Content n8n-workflows/publish.json.tmp

curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/publish.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$PUBLISH_ID`. **Ativar** (`POST /api/v1/workflows/$PUBLISH_ID/activate`).

- [ ] **Step 3: Testar isolado com `dry_run=true` primeiro (seed já tem isso como default)**

Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$PUBLISH_ID` e o `run_id`/`niche_id` de teste que teve `status='aprovado'` no Task 2, executar via MCP.

Expected: caminho `Is dry run?` → TRUE → `Mark dry-run stop`, `current_step` vira `'dry_run_stop'`, **nenhuma chamada real ao YouTube acontece**. Confirmar isso olhando o painel de execução do MCP (os nodes de upload não aparecem executados).

- [ ] **Step 4: Testar publish real (opcional, só quando quiser validar o upload de verdade)**

```sql
UPDATE postador.niches SET dry_run = false WHERE id = <niche_id de teste>;
```

Rodar de novo o mesmo `run_id`/`niche_id`. Expected: os 2 uploads acontecem, `youtube_video_id`/`youtube_shorts_id` preenchidos, `status='publicado'`. Como `privacyStatus` está `private`, o vídeo **não fica público** — abrir `https://studio.youtube.com` logado na conta certa pra conferir os 2 uploads na aba de vídeos privados. Trocar `privacyStatus` pra `public`/`unlisted` no JSON (e re-registrar via `PATCH /api/v1/workflows/{id}`) só quando estiver pronto pra publicar de verdade.

Depois do teste, rodar `UPDATE postador.niches SET dry_run = true WHERE id = <niche_id de teste>;` de novo pra não deixar o nicho de teste publicando de verdade por acidente em execuções futuras.

- [ ] **Step 5: Commit**

```bash
git add n8n-workflows/publish.json
git commit -m "feat(n8n): add Publish sub-workflow (YouTube upload 16:9 + Shorts, dry_run gate, private by default)"
```

---

## Self-Review

- **Cobertura**: itens 6-7 da seção "Arquitetura de Workflows" do spec (Aprovação, Publish), incluindo os 2 modos de aprovação (`manual`/`auto`) e o gate `dry_run` antes de qualquer chamada real ao YouTube. ✅
- **Sem placeholders de lógica**: todo Code/IF/query é literal e completo. Únicos placeholders são segredo/instância (`__PG_CRED_ID__`, `__TG_CRED_ID__`, `__YOUTUBE_CRED_ID__`/`__YOUTUBE_CRED_NAME__`). ✅
- **Risco verificado, não adivinhado**: os 2 pontos de maior incerteza do pipeline inteiro (schema exato do node YouTube, mecanismo de aprovação via Telegram) foram checados lendo o **código-fonte oficial do n8n no GitHub** nesta sessão (`VideoDescription.ts`, `Telegram.node.ts`, `hitl/webhook.ts`, `sendAndWait/utils.ts`), não estimados de memória — reduz drasticamente o risco de retrabalho na hora de rodar de verdade. ✅
- **Segurança**: `privacyStatus: 'private'` como default deliberado — publicar publicamente é ação externa difícil de desfazer, fica como troca manual e consciente (documentada no Step 4), não um default que expõe conteúdo sem confirmação explícita. ✅
- **Consistência**: `run_id`/`niche_id` sempre via `$node["Execute Workflow Trigger"]`; nomes de coluna (`status`, `current_step`, `youtube_video_id`, `youtube_shorts_id`) batem com o schema do plano de fundações. ✅
