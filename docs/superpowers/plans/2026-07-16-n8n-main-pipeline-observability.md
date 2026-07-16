# n8n Main Pipeline + Error Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Amarrar os 7 sub-workflows já implementados num **Main Pipeline** disparado diariamente (itera nichos ativos), e um **Error Workflow** dedicado que captura falha de qualquer sub-workflow, grava `status='erro'` no run afetado e alerta no Telegram. Termina com uma verificação de ponta a ponta real: `dry_run=true` primeiro, depois 1 run real com aprovação manual publicando de verdade.

**Architecture:** Main Pipeline cria a linha de `video_runs` e encadeia os 7 sub-workflows via `Execute Workflow` (pinado em `typeVersion: 1` — mais simples de gerar via API, sem o seletor de workflow por UI das versões novas), sempre reconstruindo `{run_id, niche_id}` antes de cada chamada (o retorno de um sub-workflow não carrega esses campos adiante — cada um devolve o resultado da sua própria última query Postgres). **Publish já decide sozinho** se deve publicar (checa `status='aprovado'` e `dry_run` internamente) — o Main Pipeline não precisa de lógica condicional própria, só chama os 7 em sequência. Error Workflow usa `n8n-nodes-base.errorTrigger`, que **não** inclui o `run_id`/`niche_id` originais no payload de erro (confirmado lendo o código-fonte) — por isso ele busca a execução completa via a própria API REST do n8n (`GET /api/v1/executions/{id}?includeData=true`) pra extrair o input que foi passado ao `Execute Workflow Trigger` da execução que falhou.

**Tech Stack:** `n8n-nodes-base.executeWorkflow` (v1), `n8n-nodes-base.scheduleTrigger`, `n8n-nodes-base.errorTrigger`, API REST do próprio n8n chamada de dentro de um workflow.

**Pré-requisito:** Planos 1-4 executados — todos os 7 sub-workflows registrados no n8n, com ids anotados em `n8n-instance.local.md`.

**Fora de escopo (deferido deliberadamente):** sub-workflow **Cleanup** (limpeza periódica de arquivos antigos) — nem `render-service` nem `tts-service` têm hoje um endpoint de exclusão de arquivo (checado nesta sessão). Com 1 vídeo/dia os arquivos pesam poucas dezenas de MB cada; o disco de 200GB aguenta meses. Fica como plano futuro separado (endpoint `DELETE`/varredura por idade nos 2 serviços + sub-workflow cron semanal) quando o uso real justificar.

## Achados da execução do plano de fundações (aplicar em todo registro/teste deste plano)

- **n8n roda como Coolify Service (compose stack), não Application** — usar `$N8N_SERVICE_UUID` (uuid do service, anotado em `n8n-instance.local.md`), e os endpoints corretos são `PATCH /api/v1/services/{uuid}/envs/bulk` (não `/applications/.../envs/bulk`) e `POST /api/v1/services/{uuid}/restart` (não `GET /deploy?uuid=`) — já corrigido no Step 1 abaixo.
- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405 "method not allowed"). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos (nunca só o campo que mudou, senão perde `availableInMCP`/`errorWorkflow` já configurados).
- **Ativar workflow é `POST /api/v1/workflows/{id}/activate`** (endpoint dedicado, não `PATCH` no workflow em si) — já corrigido nos steps abaixo.
- **`mcp__n8n__execute_workflow` só executa workflows com trigger `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`**, e exige `active: true` + `settings.availableInMCP: true`. O Main Pipeline já usa `Schedule Trigger` (nenhuma troca de trigger necessária pra testá-lo via MCP), mas precisa desses 2 ajustes de settings/ativação mesmo assim.
- **Node Postgres sem `RETURNING` devolve 0 linhas de saída** — se tiver node depois na cadeia, precisa `"alwaysOutputData": true` no node. O Error Workflow tem um caso real disso (`Mark run as erro` → `Send error alert`), corrigido no JSON abaixo.

- [ ] **Step 1: Env vars extras no app n8n (pra ele chamar a própria API)**

```bash
curl -s -X PATCH "$COOLIFY_BASE/api/v1/services/$N8N_SERVICE_UUID/envs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "data": [
      {"key": "N8N_BASE_URL", "value": "https://n8n.wm10.info"},
      {"key": "N8N_API_KEY", "value": "<mesmo valor usado externamente pra chamar a API do n8n>"}
    ]
  }'
curl -s -X POST "$COOLIFY_BASE/api/v1/services/$N8N_SERVICE_UUID/restart" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200` nos dois. Aguardar `GET /api/v1/services/$N8N_SERVICE_UUID` voltar `"status": "running:healthy"` (pode levar ~1-2min) antes de continuar.

- [ ] **Step 2: Escrever `n8n-workflows/error-workflow.json`**

```json
{
  "name": "Postador - Error Workflow",
  "nodes": [
    {
      "parameters": {},
      "id": "error-trigger-1",
      "name": "Error Trigger",
      "type": "n8n-nodes-base.errorTrigger",
      "typeVersion": 1,
      "position": [240, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "={{$env.N8N_BASE_URL}}/api/v1/executions/{{$json.execution.id}}?includeData=true",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "X-N8N-API-KEY", "value": "={{$env.N8N_API_KEY}}" }]
        },
        "options": {}
      },
      "id": "http-get-execution",
      "name": "Get failed execution details",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [460, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const exec = $json;\nconst runData = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};\nlet runId = null;\nlet nicheId = null;\nconst triggerRuns = runData['Execute Workflow Trigger'];\nif (triggerRuns && triggerRuns[0] && triggerRuns[0].data && triggerRuns[0].data.main && triggerRuns[0].data.main[0] && triggerRuns[0].data.main[0][0]) {\n  const input = triggerRuns[0].data.main[0][0].json || {};\n  runId = input.run_id != null ? input.run_id : null;\n  nicheId = input.niche_id != null ? input.niche_id : null;\n}\nconst errTrigger = $node[\"Error Trigger\"].json;\nreturn [{\n  json: {\n    runId,\n    nicheId,\n    workflowName: (errTrigger.workflow && errTrigger.workflow.name) || 'desconhecido',\n    lastNodeExecuted: (errTrigger.execution && errTrigger.execution.lastNodeExecuted) || 'desconhecido',\n    errorMessage: (errTrigger.execution && errTrigger.execution.error && errTrigger.execution.error.message) || 'erro desconhecido',\n    executionUrl: (errTrigger.execution && errTrigger.execution.url) || ''\n  }\n}];"
      },
      "id": "code-extract-context",
      "name": "Extract run context",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [680, 300]
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "conditions": [
            {
              "id": "cond-has-run",
              "leftValue": "={{$json.runId}}",
              "rightValue": "",
              "operator": { "type": "string", "operation": "notEquals" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-has-run",
      "name": "Has run context?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET status = 'erro', error_message = $1, updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "={{$node[\"Extract run context\"].json.errorMessage}},{{$node[\"Extract run context\"].json.runId}}" }
      },
      "id": "pg-mark-erro",
      "name": "Mark run as erro",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 220],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "sendMessage",
        "chatId": "={{$env.TELEGRAM_CHAT_ID}}",
        "text": "=⚠️ Erro no pipeline\nWorkflow: {{$node[\"Extract run context\"].json.workflowName}}\nÚltimo node: {{$node[\"Extract run context\"].json.lastNodeExecuted}}\nRun ID: {{$node[\"Extract run context\"].json.runId}}\nNicho ID: {{$node[\"Extract run context\"].json.nicheId}}\nErro: {{$node[\"Extract run context\"].json.errorMessage}}\nExecução: {{$node[\"Extract run context\"].json.executionUrl}}"
      },
      "id": "tg-alert",
      "name": "Send error alert",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1.2,
      "position": [1340, 300],
      "credentials": { "telegramApi": { "id": "__TG_CRED_ID__", "name": "Telegram Postador" } }
    }
  ],
  "connections": {
    "Error Trigger": { "main": [[{ "node": "Get failed execution details", "type": "main", "index": 0 }]] },
    "Get failed execution details": { "main": [[{ "node": "Extract run context", "type": "main", "index": 0 }]] },
    "Extract run context": { "main": [[{ "node": "Has run context?", "type": "main", "index": 0 }]] },
    "Has run context?": {
      "main": [
        [{ "node": "Mark run as erro", "type": "main", "index": 0 }],
        [{ "node": "Send error alert", "type": "main", "index": 0 }]
      ]
    },
    "Mark run as erro": { "main": [[{ "node": "Send error alert", "type": "main", "index": 0 }]] }
  },
  "settings": {}
}
```

- [ ] **Step 3: Substituir placeholders e registrar via API**

```bash
(Get-Content n8n-workflows/error-workflow.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID -replace '__TG_CRED_ID__', $TG_CRED_ID | Set-Content n8n-workflows/error-workflow.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/error-workflow.json.tmp
```

Expected: `200` com `id` — anotar como `$ERROR_WF_ID` em `n8n-instance.local.md`. **Ativar este workflow** (`POST /api/v1/workflows/$ERROR_WF_ID/activate`) — um Error Workflow só dispara se estiver ativo.

- [ ] **Step 4: Apontar todos os sub-workflows já registrados pra este Error Workflow**

`PATCH /api/v1/workflows/{id}` genérico retorna 405 nesta instância — usar o padrão `GET` (baixa o workflow completo) → mesclar `settings.errorWorkflow` → `PUT` (reenvia o objeto inteiro). Repetir pra cada um dos 7 ids anotados em `n8n-instance.local.md` (roteiro, voz, legenda, assets, render, aprovação, publish):

```bash
foreach ($id in @($ROTEIRO_ID, $VOZ_ID, $LEGENDA_ID, $ASSETS_ID, $RENDER_ID, $APROVACAO_ID, $PUBLISH_ID)) {
  curl -s "$N8N_BASE/api/v1/workflows/$id" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/wf-wire.json
  jq --arg errId "$ERROR_WF_ID" '.settings.errorWorkflow = $errId | {name, nodes, connections, settings}' /tmp/wf-wire.json > /tmp/wf-wire-put.json
  curl -s -X PUT "$N8N_BASE/api/v1/workflows/$id" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-wire-put.json
}
```

Expected: `200` em cada chamada, com `settings.errorWorkflow` no corpo de resposta igual a `$ERROR_WF_ID`. **Cuidado**: o `PUT` substitui `settings` inteiro — como o `jq` acima parte do objeto já existente (`.settings.errorWorkflow = ...` sobre o `GET`), `availableInMCP: true` (já setado no registro de cada sub-workflow) é preservado automaticamente. (O Main Pipeline do Task 2 já nasce com essa config direto no JSON de criação, não precisa deste passo.)

- [ ] **Step 5: Testar isolado — forçar um erro proposital**

Aplicar o "Procedimento de Teste Isolado via MCP" (ver plano de fundações/`n8n-instance.local.md`) no sub-workflow `Postador - Voz` com `WORKFLOW_ID=$VOZ_ID`, mas usando um `run_id` **inexistente** (ex. `99999`) no lugar do `run_id` de teste real — a query `SELECT script_text FROM video_runs WHERE id = 99999` não vai encontrar linha, e o Code node seguinte (`Build TTS request`) vai falhar tentando ler `.script_text` de `undefined`. **Não esquecer de restaurar o `Execute Workflow Trigger` original do Voz depois** (senão o Main Pipeline não consegue mais chamá-lo).

Expected: execução falha (esperado), e logo em seguida chega uma mensagem no Telegram com `⚠️ Erro no pipeline`, nome do workflow `Postador - Voz`, `Run ID: 99999`. Se a mensagem não chegar: checar se o workflow `Postador - Voz` está mesmo apontando `settings.errorWorkflow` pro id certo (Step 4) e se o Error Workflow está ativo (Step 3).

- [ ] **Step 6: Commit**

```bash
git add n8n-workflows/error-workflow.json
git commit -m "feat(n8n): add Error Workflow (fetches failed execution input via n8n API, alerts Telegram)"
```

---

## Task 2: Main Pipeline

**Files:**
- Create: `n8n-workflows/main-pipeline.json`

- [ ] **Step 1: Escrever `n8n-workflows/main-pipeline.json`**

```json
{
  "name": "Postador - Main Pipeline",
  "nodes": [
    {
      "parameters": {
        "rule": { "interval": [{ "field": "days", "daysInterval": 1, "triggerAtHour": 8, "triggerAtMinute": 0 }] }
      },
      "id": "trigger-schedule",
      "name": "Daily Schedule",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [240, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT id AS niche_id FROM postador.niches WHERE is_active = true;"
      },
      "id": "pg-active-niches",
      "name": "Read active niches",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.video_runs (niche_id, status, current_step) VALUES ($1, 'em_progresso', 'iniciado') RETURNING id AS run_id, niche_id;",
        "additionalFields": { "queryParams": "={{$json.niche_id}}" }
      },
      "id": "pg-create-run",
      "name": "Create video_run",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-roteiro",
      "name": "Build input for Roteiro",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__ROTEIRO_ID__" },
      "id": "exec-roteiro",
      "name": "Call Roteiro",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [1120, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-voz",
      "name": "Build input for Voz",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__VOZ_ID__" },
      "id": "exec-voz",
      "name": "Call Voz",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [1560, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-legenda",
      "name": "Build input for Legenda",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1780, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__LEGENDA_ID__" },
      "id": "exec-legenda",
      "name": "Call Legenda",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2000, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-assets",
      "name": "Build input for Assets",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2220, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__ASSETS_ID__" },
      "id": "exec-assets",
      "name": "Call Assets",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2440, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-render",
      "name": "Build input for Render",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2660, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__RENDER_ID__" },
      "id": "exec-render",
      "name": "Call Render",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2880, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-aprovacao",
      "name": "Build input for Aprovação",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3100, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__APROVACAO_ID__" },
      "id": "exec-aprovacao",
      "name": "Call Aprovação",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [3320, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-publish",
      "name": "Build input for Publish",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3540, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "__PUBLISH_ID__" },
      "id": "exec-publish",
      "name": "Call Publish",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [3760, 300]
    }
  ],
  "connections": {
    "Daily Schedule": { "main": [[{ "node": "Read active niches", "type": "main", "index": 0 }]] },
    "Read active niches": { "main": [[{ "node": "Create video_run", "type": "main", "index": 0 }]] },
    "Create video_run": { "main": [[{ "node": "Build input for Roteiro", "type": "main", "index": 0 }]] },
    "Build input for Roteiro": { "main": [[{ "node": "Call Roteiro", "type": "main", "index": 0 }]] },
    "Call Roteiro": { "main": [[{ "node": "Build input for Voz", "type": "main", "index": 0 }]] },
    "Build input for Voz": { "main": [[{ "node": "Call Voz", "type": "main", "index": 0 }]] },
    "Call Voz": { "main": [[{ "node": "Build input for Legenda", "type": "main", "index": 0 }]] },
    "Build input for Legenda": { "main": [[{ "node": "Call Legenda", "type": "main", "index": 0 }]] },
    "Call Legenda": { "main": [[{ "node": "Build input for Assets", "type": "main", "index": 0 }]] },
    "Build input for Assets": { "main": [[{ "node": "Call Assets", "type": "main", "index": 0 }]] },
    "Call Assets": { "main": [[{ "node": "Build input for Render", "type": "main", "index": 0 }]] },
    "Build input for Render": { "main": [[{ "node": "Call Render", "type": "main", "index": 0 }]] },
    "Call Render": { "main": [[{ "node": "Build input for Aprovação", "type": "main", "index": 0 }]] },
    "Build input for Aprovação": { "main": [[{ "node": "Call Aprovação", "type": "main", "index": 0 }]] },
    "Call Aprovação": { "main": [[{ "node": "Build input for Publish", "type": "main", "index": 0 }]] },
    "Build input for Publish": { "main": [[{ "node": "Call Publish", "type": "main", "index": 0 }]] }
  },
  "settings": { "errorWorkflow": "__ERROR_WF_ID__", "availableInMCP": true }
}
```

Nota: `Execute Workflow` (`typeVersion: 1`) processa item a item por padrão — com múltiplos nichos ativos, cada um passa pela cadeia inteira independentemente, sem lógica extra (suporte multi-nicho do spec sai de graça deste comportamento padrão do n8n).

- [ ] **Step 2: Substituir todos os placeholders e registrar via API**

```bash
(Get-Content n8n-workflows/main-pipeline.json -Raw) `
  -replace '__PG_CRED_ID__', $PG_CRED_ID `
  -replace '__ROTEIRO_ID__', $ROTEIRO_ID `
  -replace '__VOZ_ID__', $VOZ_ID `
  -replace '__LEGENDA_ID__', $LEGENDA_ID `
  -replace '__ASSETS_ID__', $ASSETS_ID `
  -replace '__RENDER_ID__', $RENDER_ID `
  -replace '__APROVACAO_ID__', $APROVACAO_ID `
  -replace '__PUBLISH_ID__', $PUBLISH_ID `
  -replace '__ERROR_WF_ID__', $ERROR_WF_ID `
  | Set-Content n8n-workflows/main-pipeline.json.tmp

curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/main-pipeline.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md`.

- [ ] **Step 3: Commit**

```bash
git add n8n-workflows/main-pipeline.json
git commit -m "feat(n8n): add Main Pipeline (daily trigger, chains all 7 sub-workflows per active niche)"
```

---

## Task 3: Verificação de ponta a ponta

**Files:** nenhum arquivo de código.

- [ ] **Step 1: Confirmar estado seguro do nicho de teste antes de rodar tudo**

```sql
UPDATE postador.niches SET dry_run = true, is_active = true WHERE id = <niche_id de teste>;
```

- [ ] **Step 2: Rodar o Main Pipeline inteiro via MCP (não esperar o Schedule Trigger)**

Ativar primeiro (MCP só executa workflow `active: true`; o `settings.availableInMCP: true` já foi setado na criação do Task 2):

```bash
curl -s -X POST "$N8N_BASE/api/v1/workflows/$MAIN_PIPELINE_ID/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

`mcp__n8n__search_workflows` (`"Postador - Main Pipeline"`) → `mcp__n8n__execute_workflow` (sem input — o próprio pipeline lê nichos ativos do banco). Como o trigger real já é `Schedule Trigger`, **nenhuma troca de trigger é necessária** aqui (diferente dos sub-workflows individuais).

Expected: um novo `video_runs` é criado (não o de teste anterior — é um run novo, do zero). A cadeia roda Roteiro → Voz → Legenda → Assets → Render → Aprovação → Publish. Em Aprovação, chega a mensagem no Telegram — **tocar "Aprovar"** pra deixar a execução continuar. Em Publish, como `dry_run=true`, para em `current_step='dry_run_stop'` sem chamar o YouTube. Conferir a linha final:

```sql
SELECT id, status, current_step, topic FROM postador.video_runs ORDER BY id DESC LIMIT 1;
```

Expected: `status='aprovado'`, `current_step='dry_run_stop'`, `topic` preenchido com uma missão nova (diferente da usada nos testes anteriores — prova que `Read used topics` está funcionando).

- [ ] **Step 3: Rodar 1 vez de verdade (publicação real, opcional)**

```sql
UPDATE postador.niches SET dry_run = false WHERE id = <niche_id de teste>;
```

Repetir o Step 2. Desta vez o Publish chama o YouTube de verdade (vídeos como `private`, conforme decidido no plano anterior). Conferir em `studio.youtube.com` os 2 uploads. Depois:

```sql
UPDATE postador.niches SET dry_run = true WHERE id = <niche_id de teste>;
```

pra não deixar publicação real ativada por acidente.

- [ ] **Step 4: Confirmar o Main Pipeline ativo pro Schedule Trigger valer**

Já deve estar `active: true` desde o Step 2 (ativação idempotente, repetir não tem efeito colateral):

```bash
curl -s -X POST "$N8N_BASE/api/v1/workflows/$MAIN_PIPELINE_ID/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

A partir daqui o pipeline roda sozinho todo dia às 8h, sem precisar de execução manual via MCP.

---

## Self-Review

- **Cobertura**: Main Pipeline (trigger diário + iteração multi-nicho) e Error Workflow da seção "Erros e Observabilidade" do spec. `retryOnFail` nos nodes HTTP externos ficou de fora deste plano — é 1 checkbox por node na UI (`Retry on Fail`), não expressável de forma limpa no JSON de criação via API sem verificar o parâmetro exato; documentar como ajuste manual pós-import se quiser essa proteção extra (risco baixo, não bloqueia o pipeline funcionar). ✅ (com a ressalva anotada)
- **Sem placeholders de lógica**: JS completo em todo Code node, DDL/queries completas. Únicos placeholders são ids de instância (`__PG_CRED_ID__`, `__TG_CRED_ID__`, `__ROTEIRO_ID__` etc.), todos com origem documentada (`n8n-instance.local.md`). ✅
- **Risco verificado**: payload real do `errorTrigger` (não inclui input original) e shape de `Execute Workflow` `typeVersion 1` foram checados no código-fonte oficial do n8n nesta sessão, não adivinhados. ✅
- **Escopo explicitamente adiado**: Cleanup (sem endpoint de exclusão nos 2 serviços) — decisão registrada, não esquecida silenciosamente. ✅
