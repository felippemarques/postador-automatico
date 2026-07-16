# n8n Roteiro + Voz + Legenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar os 3 primeiros sub-workflows do pipeline: **Roteiro** (OpenRouter gera tema + texto), **Voz** (tts-service sintetiza o áudio) e **Legenda** (whisper-service transcreve com timing). No fim deste plano, um `video_runs` de teste sai com `script_text`, `voice_url` e `captions_json` preenchidos, prontos pra alimentar Assets/Render (próximo plano).

**Architecture:** Cada sub-workflow é 1 arquivo JSON em `n8n-workflows/`, registrado via API do n8n, começando com node `n8n-nodes-base.executeWorkflowTrigger` (recebe `{run_id, niche_id}`). Toda leitura/escrita no Postgres usa o node `n8n-nodes-base.postgres` com **queries parametrizadas** (`$1, $2, ...` + campo `queryParams`), nunca concatenação de string — evita escaping manual de aspas em texto gerado por LLM. Toda chamada HTTP externa usa `n8n-nodes-base.httpRequest` com header `Authorization` lido via expression `{{$env.NOME_DA_VAR}}` (convenção travada no plano de fundações).

**Tech Stack:** node Postgres (`operation: executeQuery` + `queryParams`), node HTTP Request, node Code (JS), OpenRouter (`chat/completions`, modelo `deepseek/deepseek-chat`), `tts-service` (`/synthesize`), `whisper-service` (`/transcribe`).

**Pré-requisito:** Plano `docs/superpowers/plans/2026-07-16-n8n-foundations.md` executado — schema `postador` criado, `docs/superpowers/plans/n8n-instance.local.md` com `PG_CRED_ID`, `niche_id` e `run_id` de teste preenchidos, env vars `OPENROUTER_API_KEY`/`TTS_AUTH_TOKEN`/`WHISPER_AUTH_TOKEN` confirmadas no app n8n.

---

## Convenção adicional usada neste plano (e nos 2 seguintes)

- **Referenciar `run_id`/`niche_id` sempre pelo node de trigger**: em qualquer node não-adjacente ao trigger, usar `{{$node["Execute Workflow Trigger"].json.run_id}}` / `.niche_id` diretamente — nunca tentar arrastar esses campos manualmente através de cada node Postgres intermediário (o resultado de uma query substitui os campos do item, não os soma).
- **Contratos reais dos microserviços** (confirmados lendo o código-fonte nesta sessão, não o spec macro que estava desatualizado num ponto):
  - `whisper-service` `POST /transcribe` espera `{"audioUrl": "<url pública>"}`, devolve `{"text", "segments": [{"text","start","end"}], "words": [{"word","start","end"}]}`.
  - `render-service` `POST /render` espera `captions` no formato **igual** ao `segments` do whisper (`{text, start, end}`) — por isso a Legenda grava `segments` inteiro (não `words`) num campo novo `postador.video_runs.captions_json` (coluna `JSONB` — **ausente no spec original, adicionada no plano de fundações**; se você pulou aquele plano, adicionar `ALTER TABLE postador.video_runs ADD COLUMN IF NOT EXISTS captions_json JSONB;` antes de continuar aqui).
  - `tts-service` `POST /synthesize` devolve `url` **relativa** (ex. `/files/abc123.wav`) — todo node que consome essa URL precisa prefixar com a base do serviço antes de gravar em `video_runs` ou passar adiante.

## Achados da execução do plano de fundações (aplicar em todo registro/teste deste plano)

- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405 "method not allowed"). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos, nunca só o campo que mudou.
- **`mcp__n8n__execute_workflow` só executa workflows cujo primeiro node é `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`** — `Execute Workflow Trigger` (o node de entrada de todo sub-workflow deste plano) **não está nessa lista** e será rejeitado com `"Only workflows with the following trigger nodes can be executed..."`. Além disso, o workflow precisa estar `active: true` **e** `settings.availableInMCP: true` (nenhum dos dois é default). Por isso cada workflow deste plano já nasce com `"settings": {"availableInMCP": true}` no JSON, e o registro inclui um passo de ativação — mas isso **não resolve** o problema do tipo de trigger, só o de permissão.
- **Procedimento de Teste Isolado via MCP** (usar em toda etapa "Testar isolado" deste plano): trocar temporariamente o `Execute Workflow Trigger` por um `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste, apontando pra mesma conexão original; testar via MCP; depois **restaurar o original** (senão o Main Pipeline do plano 5 não consegue mais chamar esse sub-workflow via Execute Workflow).

```bash
# $N8N_BASE, $N8N_API_KEY já setados. $WORKFLOW_ID = id anotado no registro do sub-workflow.
# $TEST_RUN_ID / $TEST_NICHE_ID = valores de n8n-instance.local.md.

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

Executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $WORKFLOW_ID`, sem `inputs`). Depois de conferir o resultado, restaurar:

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-live.json
```

- **Node Postgres (`typeVersion: 1`) não avalia `{{ }}` dentro do campo `query`**, mesmo com prefixo `=` — este plano já usa exclusivamente `$1, $2...` + `additionalFields.queryParams` (confirmado funcionando na prática), nunca interpolação direta na string da query. Não alterar esse padrão.
- **Node Postgres que roda só `INSERT`/`UPDATE` sem `RETURNING` devolve 0 linhas de saída** — se ele tiver um node **depois** dele na cadeia, adicionar `"alwaysOutputData": true` no node (propriedade no nível do node, ao lado de `"parameters"`), senão a cadeia trava ali. Nos sub-workflows deste plano isso não é necessário (toda query sem `RETURNING` é o último node da cadeia), mas fica registrado pro plano de observabilidade (Error Workflow tem um caso real disso).

---

## Task 1: Sub-workflow Roteiro

**Files:**
- Create: `n8n-workflows/roteiro.json`

- [ ] **Step 1: Escrever `n8n-workflows/roteiro.json`**

```json
{
  "name": "Postador - Roteiro",
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
        "query": "SELECT id, prompt_template, voice_id FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$json.niche_id}}" }
      },
      "id": "pg-read-niche",
      "name": "Read niche",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT topic FROM postador.topics_used WHERE niche_id = $1 ORDER BY created_at DESC LIMIT 30;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.niche_id}}" }
      },
      "id": "pg-read-topics",
      "name": "Read used topics",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const niche = $node[\"Read niche\"].json;\nconst usedTopics = $input.all().map(item => item.json.topic).filter(Boolean);\nconst usedTopicsCsv = usedTopics.length ? usedTopics.join(', ') : 'nenhum ainda';\nconst prompt = niche.prompt_template.replace('{{used_topics}}', usedTopicsCsv);\nreturn [{ json: { prompt } }];"
      },
      "id": "code-build-prompt",
      "name": "Build prompt",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "Authorization", "value": "=Bearer {{$env.OPENROUTER_API_KEY}}" },
            { "name": "Content-Type", "value": "application/json" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { model: 'deepseek/deepseek-chat', messages: [ { role: 'user', content: $json.prompt } ] } }}",
        "options": {}
      },
      "id": "http-openrouter",
      "name": "Call OpenRouter",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const raw = $json.choices[0].message.content;\nconst cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();\nconst parsed = JSON.parse(cleaned);\nreturn [{ json: { topic: parsed.topic, script: parsed.script } }];"
      },
      "id": "code-parse-llm",
      "name": "Parse LLM JSON",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET script_text = $1, topic = $2, current_step = 'roteiro', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "={{$json.script}},{{$json.topic}},{{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-save-script",
      "name": "Save script",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.topics_used (niche_id, topic) VALUES ($1, $2);",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.niche_id}},{{$json.topic}}" }
      },
      "id": "pg-insert-topic",
      "name": "Insert topics_used",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1780, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read niche", "type": "main", "index": 0 }]] },
    "Read niche": { "main": [[{ "node": "Read used topics", "type": "main", "index": 0 }]] },
    "Read used topics": { "main": [[{ "node": "Build prompt", "type": "main", "index": 0 }]] },
    "Build prompt": { "main": [[{ "node": "Call OpenRouter", "type": "main", "index": 0 }]] },
    "Call OpenRouter": { "main": [[{ "node": "Parse LLM JSON", "type": "main", "index": 0 }]] },
    "Parse LLM JSON": { "main": [[{ "node": "Save script", "type": "main", "index": 0 }]] },
    "Save script": { "main": [[{ "node": "Insert topics_used", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
N8N_BASE="https://n8n.wm10.info"
N8N_API_KEY="<obter com o operador — não versionar>"
PG_CRED_ID="<do arquivo n8n-instance.local.md>"

(Get-Content n8n-workflows/roteiro.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/roteiro.json.tmp

curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/roteiro.json.tmp
```

Expected: `200`, JSON com `id` do workflow. Apagar o `.tmp` depois. Anotar o id em `n8n-instance.local.md` como `$ROTEIRO_ID`.

- [ ] **Step 3: Testar isolado**

Aplicar o "Procedimento de Teste Isolado via MCP" (seção de convenções acima) com `WORKFLOW_ID=$ROTEIRO_ID`. Depois de aplicado o trigger de teste, executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $ROTEIRO_ID`).

Expected: execução verde em todos os nodes. Conferir na saída do node `Parse LLM JSON` um `topic` curto e um `script` de ~130-160 palavras, tom "Capitão do Esquadrão" (sem bronca, frases curtas). Se o `Call OpenRouter` falhar com erro de auth: confirmar que `OPENROUTER_API_KEY` está mesmo setada no container (Task 4 do plano de fundações). Se `Parse LLM JSON` falhar com `JSON.parse` inválido: o modelo devolveu texto fora do JSON pedido — abrir a saída bruta do `Call OpenRouter` e ajustar o prompt em `postador.niches.prompt_template` reforçando "responda SOMENTE em JSON".

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/roteiro.json
git commit -m "feat(n8n): add Roteiro sub-workflow (OpenRouter script generation)"
```

---

## Task 2: Sub-workflow Voz

**Files:**
- Create: `n8n-workflows/voz.json`

- [ ] **Step 1: Escrever `n8n-workflows/voz.json`**

```json
{
  "name": "Postador - Voz",
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
        "query": "SELECT script_text FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$json.run_id}}" }
      },
      "id": "pg-read-script",
      "name": "Read script",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT voice_id FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$node[\"Execute Workflow Trigger\"].json.niche_id}}" }
      },
      "id": "pg-read-voice",
      "name": "Read voice",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { text: $node[\"Read script\"].json.script_text, voice: $node[\"Read voice\"].json.voice_id } }];"
      },
      "id": "code-build-tts",
      "name": "Build TTS request",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io/synthesize",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "Authorization", "value": "=Bearer {{$env.TTS_AUTH_TOKEN}}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { text: $json.text, voice: $json.voice } }}",
        "options": {}
      },
      "id": "http-tts",
      "name": "Call tts-service",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const TTS_BASE = 'http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io';\nreturn [{ json: { voice_url: TTS_BASE + $json.url } }];"
      },
      "id": "code-absolute-url",
      "name": "Build absolute URL",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET voice_url = $1, current_step = 'voz', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "={{$json.voice_url}},{{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-save-voice",
      "name": "Save voice_url",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read script", "type": "main", "index": 0 }]] },
    "Read script": { "main": [[{ "node": "Read voice", "type": "main", "index": 0 }]] },
    "Read voice": { "main": [[{ "node": "Build TTS request", "type": "main", "index": 0 }]] },
    "Build TTS request": { "main": [[{ "node": "Call tts-service", "type": "main", "index": 0 }]] },
    "Call tts-service": { "main": [[{ "node": "Build absolute URL", "type": "main", "index": 0 }]] },
    "Build absolute URL": { "main": [[{ "node": "Save voice_url", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/voz.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/voz.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/voz.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$VOZ_ID`.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id` de teste do Task 1 (já tem `script_text` preenchido). Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$VOZ_ID`, executar via MCP.

Expected: execução verde, `voice_url` salvo é uma URL absoluta terminando em `.wav`. Baixar e ouvir pra confirmar áudio real em português com a voz `pt_BR-faber-medium`.

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/voz.json
git commit -m "feat(n8n): add Voz sub-workflow (tts-service synthesis)"
```

---

## Task 3: Sub-workflow Legenda

**Files:**
- Create: `n8n-workflows/legenda.json`

- [ ] **Step 1: Escrever `n8n-workflows/legenda.json`**

```json
{
  "name": "Postador - Legenda",
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
        "query": "SELECT voice_url FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "={{$json.run_id}}" }
      },
      "id": "pg-read-voice-url",
      "name": "Read voice_url",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://g12r5wkmvc92no60fqx6tbhr.137.131.180.11.sslip.io/transcribe",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "Authorization", "value": "=Bearer {{$env.WHISPER_AUTH_TOKEN}}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { audioUrl: $json.voice_url } }}",
        "options": {}
      },
      "id": "http-whisper",
      "name": "Call whisper-service",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [680, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET captions_json = $1, current_step = 'legenda', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "={{JSON.stringify($json.segments)}},{{$node[\"Execute Workflow Trigger\"].json.run_id}}" }
      },
      "id": "pg-save-captions",
      "name": "Save captions",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [900, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read voice_url", "type": "main", "index": 0 }]] },
    "Read voice_url": { "main": [[{ "node": "Call whisper-service", "type": "main", "index": 0 }]] },
    "Call whisper-service": { "main": [[{ "node": "Save captions", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/legenda.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/legenda.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/legenda.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$LEGENDA_ID`.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id` de teste (já tem `voice_url` preenchido pelo Task 2). Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$LEGENDA_ID`, executar via MCP.

Expected: execução verde, `captions_json` salvo é um array de objetos `{"text","start","end"}` cobrindo a duração inteira do áudio. Se `Call whisper-service` retornar 401: confirmar `WHISPER_AUTH_TOKEN` no env do n8n. Se a transcrição vier vazia/lixo: o whisper-service usa `WHISPER_MODEL_SIZE=base` (config de produção) — texto em português deve transcrever razoavelmente bem, mas nomes próprios da persona ("Esquadrão") podem sair errados; isso é aceitável pro MVP (captions são só visuais, não afetam a voz já gravada).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/legenda.json
git commit -m "feat(n8n): add Legenda sub-workflow (whisper-service transcription)"
```

---

## Task 4: Verificação de ponta a ponta (Roteiro → Voz → Legenda)

**Files:**
- Create: `n8n-workflows/_check-run.json` (descartável, não precisa commit)

- [ ] **Step 1: Escrever workflow descartável de inspeção**

```json
{
  "name": "Postador - Check Run (descartável)",
  "nodes": [
    { "parameters": { "rule": { "interval": [{ "field": "days", "daysInterval": 365 }] } }, "id": "trigger-1", "name": "Schedule Trigger", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [240, 300] },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT id, current_step, topic, script_text, voice_url, captions_json FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "=<run_id de teste>" }
      },
      "id": "pg-check",
      "name": "Check row",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": { "Schedule Trigger": { "main": [[{ "node": "Check row", "type": "main", "index": 0 }]] } },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Registrar, substituindo os dois placeholders (`__PG_CRED_ID__` e `<run_id de teste>`)**

```bash
(Get-Content n8n-workflows/_check-run.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID -replace '<run_id de teste>', $TEST_RUN_ID | Set-Content n8n-workflows/_check-run.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/_check-run.json.tmp
```

Anotar o `id` retornado, depois **ativar** (MCP só executa workflow ativo):

```bash
curl -s -X POST "$N8N_BASE/api/v1/workflows/<id retornado acima>/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

- [ ] **Step 3: Executar via MCP e conferir**

Expected: 1 linha com `current_step = 'legenda'`, `topic` e `script_text` coerentes com a persona, `voice_url` terminando em `.wav`, `captions_json` com vários objetos `{text,start,end}`. Isso confirma que os 3 sub-workflows compõem corretamente sobre o mesmo `run_id`, sem passar payload gigante entre eles (só leram/escreveram a mesma linha).

- [ ] **Step 4: Apagar o workflow descartável**

```bash
curl -s -X DELETE "$N8N_BASE/api/v1/workflows/<id retornado no Step 2>" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Não commitar `n8n-workflows/_check-run.json` (é só uma ferramenta de inspeção pontual — se quiser manter pra depuração futura, commitar com o placeholder `<run_id de teste>` intacto, nunca resolvido).

---

## Self-Review

- **Cobertura**: implementa os itens 1-3 da seção "Arquitetura de Workflows" do spec (Roteiro, Voz, Legenda), incorporando a correção de contrato real dos microserviços (audioUrl, captions=segments, URL relativa do tts-service) e o fix de `{{topic}}` indevido no prompt (feito no plano de fundações antes deste). ✅
- **Sem placeholders de lógica**: todo Code node tem JS completo, toda query SQL é literal e parametrizada. Únicos placeholders são segredo/instância (`__PG_CRED_ID__`) com padrão de substituição explícito. ✅
- **Consistência de tipos**: `run_id`/`niche_id` sempre acessados via `$node["Execute Workflow Trigger"].json`, nunca arrastados manualmente entre nodes Postgres — mesmo padrão nos 3 workflows. Nome de coluna `captions_json` usado de forma idêntica aqui e no plano de fundações. ✅
- **Risco conhecido**: `response_format: json_object` foi deliberadamente **não usado** na chamada OpenRouter (suporte varia por modelo/provedor via OpenRouter) — a robustez vem do prompt ("responda SOMENTE em JSON") + parsing tolerante a cercas de markdown no `Parse LLM JSON`. Se o modelo `deepseek/deepseek-chat` ficar instável, trocar só o campo `model` no `jsonBody` do node `Call OpenRouter` — nada mais muda. ✅
