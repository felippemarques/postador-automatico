# n8n Roteiro + Voz + Legenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: executado e validado em 2026-07-17** — os 3 sub-workflows rodaram de ponta a ponta via MCP contra o `run_id=1`/`niche_id=1` de teste; `video_runs.id=1` terminou com `current_step='legenda'`, `topic`/`script_text`/`voice_url`/`captions_json` preenchidos corretamente. Este documento já reflete a versão que funcionou de verdade (não a primeira tentativa) — ver "Achados da execução" abaixo pros bugs reais encontrados e corrigidos.

**Goal:** Implementar os 3 primeiros sub-workflows do pipeline: **Roteiro** (OpenRouter gera tema + texto), **Voz** (tts-service sintetiza o áudio) e **Legenda** (whisper-service transcreve com timing). No fim deste plano, um `video_runs` de teste sai com `script_text`, `voice_url` e `captions_json` preenchidos, prontos pra alimentar Assets/Render (próximo plano).

**Architecture:** Cada sub-workflow é 1 arquivo JSON em `n8n-workflows/`, registrado via API do n8n, começando com node `n8n-nodes-base.executeWorkflowTrigger` (recebe `{run_id, niche_id}`). Toda leitura/escrita no Postgres usa o node `n8n-nodes-base.postgres` com **queries parametrizadas** (`$1, $2, ...` + campo `queryParams`) — `queryParams` é uma lista **literal, separada por vírgula, de nomes de campo do item de entrada atual** (não uma expression, não `{{ }}` — ver "Achados" abaixo). Toda chamada HTTP externa usa `n8n-nodes-base.httpRequest` com header `Authorization` lido via expression `{{$env.NOME_DA_VAR}}` (convenção travada no plano de fundações).

**Tech Stack:** node Postgres (`operation: executeQuery` + `queryParams`), node HTTP Request, node Code (JS), OpenRouter (`chat/completions`, modelo `deepseek/deepseek-chat`), `tts-service` (`/synthesize`), `whisper-service` (`/transcribe`).

**Pré-requisito:** Plano `docs/superpowers/plans/2026-07-16-n8n-foundations.md` executado — schema `postador` criado, `docs/superpowers/plans/n8n-instance.local.md` com `PG_CRED_ID`, `niche_id` e `run_id` de teste preenchidos, env vars `OPENROUTER_API_KEY`/`TTS_AUTH_TOKEN`/`WHISPER_AUTH_TOKEN` confirmadas no app n8n.

---

## Convenção adicional usada neste plano (e nos 2 seguintes)

- **Referenciar `run_id`/`niche_id` sempre pelo node de trigger dentro de Code nodes**: em qualquer Code node não-adjacente ao trigger, usar `$node["Execute Workflow Trigger"].json.run_id` / `.niche_id` diretamente — Code nodes podem referenciar qualquer node já executado, livremente. **Isso não vale pra `queryParams` de node Postgres** (ver Achados abaixo — mecanismo completamente diferente).
- **Contratos reais dos microserviços** (confirmados lendo o código-fonte nesta sessão, não o spec macro que estava desatualizado num ponto):
  - `whisper-service` `POST /transcribe` espera `{"audioUrl": "<url pública>"}`, devolve `{"text", "segments": [{"text","start","end"}], "words": [{"word","start","end"}]}`.
  - `render-service` `POST /render` espera `captions` no formato **igual** ao `segments` do whisper (`{text, start, end}`) — por isso a Legenda grava `segments` inteiro (não `words`) num campo novo `postador.video_runs.captions_json` (coluna `JSONB` — **ausente no spec original, adicionada no plano de fundações**; se você pulou aquele plano, adicionar `ALTER TABLE postador.video_runs ADD COLUMN IF NOT EXISTS captions_json JSONB;` antes de continuar aqui).
  - `tts-service` `POST /synthesize` devolve `url` **relativa** (ex. `/files/abc123.wav`) — todo node que consome essa URL precisa prefixar com a base do serviço antes de gravar em `video_runs` ou passar adiante.

## Achados da execução (aplicar em todo registro/teste deste plano e dos seguintes)

- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405 "method not allowed"). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos, nunca só o campo que mudou.
- **`mcp__n8n__execute_workflow` só executa workflows cujo primeiro node é `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`** — `Execute Workflow Trigger` não está nessa lista e será rejeitado. O workflow também precisa `active: true` **e** `settings.availableInMCP: true` (nenhum dos dois é default) — cada workflow deste plano já nasce com `"settings": {"availableInMCP": true}`, e o registro inclui ativação.
- ⚠️ **`additionalFields.queryParams` do node Postgres (`typeVersion: 1`) NÃO é uma expression `{{ }}`** — confirmado lendo `nodes-base/nodes/Postgres/v1/genericFunctions.ts`: é uma **string literal separada por vírgula com nomes de propriedade do item de entrada atual** (`item.json[nome]`, via `getItemsCopy`). Usar `"queryParams": "={{$json.niche_id}}"` (o que a primeira versão deste plano tinha) falha com `"propertiesString.split is not a function"` quando o valor resolvido não é string, ou aponta pro campo errado silenciosamente. **Correto**: `"queryParams": "niche_id"` (nome de campo puro, sem `{{ }}`, sem `=`) — e o item de entrada **precisa já ter** esse campo com esse nome exato antes do node Postgres rodar. Isso implica:
  - Nunca dá pra referenciar outro node via `queryParams` (diferente de Code nodes). Se o valor precisa vir de um node anterior que não seja o imediatamente anterior, ou combinar campos de fontes diferentes (ex. `script_text` de uma tabela + `voice_id` de outra), resolver com **uma única query com `JOIN`** (caso do sub-workflow Voz abaixo) ou um **Code node logo antes** que monta um item plano com exatamente os campos citados em `queryParams`, na ordem certa (caso do `run_id` que só existe no trigger, precisando ser copiado por um Code node pra qualquer Postgres node não-adjacente ao trigger).
  - Toda vez que um node Postgres SELECT precisa alimentar `queryParams` de um node **seguinte**, o nome da coluna retornada tem que bater com o nome usado depois — usar `AS` na query pra isso (ex. `SELECT id AS niche_id FROM niches...`).
- **Node Postgres sem `RETURNING` devolve 0 linhas de saída** — se ele tiver um node **depois** na cadeia que dependa do resultado, isso quebra a cadeia (0 itens = node seguinte nem roda). Neste plano isso só importa pro node `Read used topics` (pode legitimamente ter 0 tópicos usados na primeira execução de um nicho) — resolvido com `"alwaysOutputData": true`, e o Code node seguinte (`Build prompt`) já trata array vazio com `.filter(Boolean)`. Os `UPDATE`/`INSERT` finais de cada workflow são sempre nodes terminais (sem dependente), então não precisam disso.
- **Procedimento de Teste Isolado via MCP**: trocar temporariamente o `Execute Workflow Trigger` por `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste. ⚠️ **O Code node de substituição precisa manter o nome exato `"Execute Workflow Trigger"`** (só o `type`/`parameters` mudam) — qualquer Code node mais adiante na cadeia que referencie `$node["Execute Workflow Trigger"]` (ex. `Parse LLM JSON`, `Build absolute URL`) vai quebrar com `"Referenced node doesn't exist"` se o node de teste tiver outro nome. Renomear o node de teste evita ter que tocar em nenhum outro node da cadeia.

```bash
# $N8N_BASE, $N8N_API_KEY já setados. $WORKFLOW_ID = id anotado no registro do sub-workflow.
# $TEST_RUN_ID / $TEST_NICHE_ID = valores de n8n-instance.local.md.

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

Executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $WORKFLOW_ID`, sem `inputs`). Depois de conferir o resultado, restaurar o original (o arquivo `/tmp/wf-live.json` já baixado antes da troca):

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/$WORKFLOW_ID" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/wf-live.json
```

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
        "query": "SELECT id AS niche_id, prompt_template, voice_id FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "niche_id" }
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
        "additionalFields": { "queryParams": "niche_id" }
      },
      "id": "pg-read-topics",
      "name": "Read used topics",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "alwaysOutputData": true,
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
        "jsCode": "const raw = $json.choices[0].message.content;\nconst cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();\nconst parsed = JSON.parse(cleaned);\nreturn [{ json: { topic: parsed.topic, script: parsed.script, run_id: $node[\"Execute Workflow Trigger\"].json.run_id, niche_id: $node[\"Execute Workflow Trigger\"].json.niche_id } }];"
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
        "additionalFields": { "queryParams": "script,topic,run_id" }
      },
      "id": "pg-save-script",
      "name": "Save script",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 220],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.topics_used (niche_id, topic) VALUES ($1, $2);",
        "additionalFields": { "queryParams": "niche_id,topic" }
      },
      "id": "pg-insert-topic",
      "name": "Insert topics_used",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 400],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read niche", "type": "main", "index": 0 }]] },
    "Read niche": { "main": [[{ "node": "Read used topics", "type": "main", "index": 0 }]] },
    "Read used topics": { "main": [[{ "node": "Build prompt", "type": "main", "index": 0 }]] },
    "Build prompt": { "main": [[{ "node": "Call OpenRouter", "type": "main", "index": 0 }]] },
    "Call OpenRouter": { "main": [[{ "node": "Parse LLM JSON", "type": "main", "index": 0 }]] },
    "Parse LLM JSON": { "main": [[{ "node": "Save script", "type": "main", "index": 0 }, { "node": "Insert topics_used", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota de design: `Save script` e `Insert topics_used` são **ambos alimentados diretamente por `Parse LLM JSON`** (fan-out paralelo, não encadeados um depois do outro) — isso é deliberado: como um `UPDATE` sem `RETURNING` não devolve `topic`/`niche_id` no item de saída, encadear `Insert topics_used` depois de `Save script` quebraria a leitura de `queryParams`. Os dois lerem do mesmo item de origem evita esse problema.

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
N8N_BASE="https://n8n.wm10.info"
N8N_API_KEY="<obter com o operador — não versionar>"
PG_CRED_ID="<do arquivo n8n-instance.local.md>"

(Get-Content n8n-workflows/roteiro.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/roteiro.json.tmp

curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/roteiro.json.tmp
```

Expected: `200`, JSON com `id` do workflow. Apagar o `.tmp` depois. Anotar o id em `n8n-instance.local.md` como `$ROTEIRO_ID`. Ativar (`POST /api/v1/workflows/$ROTEIRO_ID/activate`).

- [ ] **Step 3: Testar isolado**

Aplicar o "Procedimento de Teste Isolado via MCP" (seção de convenções acima) com `WORKFLOW_ID=$ROTEIRO_ID`. Depois de aplicado o trigger de teste, executar via MCP (`mcp__n8n__execute_workflow`, `workflowId: $ROTEIRO_ID`).

Expected: execução verde em todos os nodes (`success: true` na resposta do MCP). Conferir na saída do node `Parse LLM JSON` um `topic` curto e um `script` de ~130-160 palavras, tom "Capitão do Esquadrão" (sem bronca, frases curtas) — validado nesta sessão com o modelo `deepseek/deepseek-chat` gerando "Operação Compartilhar Alegria", tom correto. Se o `Call OpenRouter` falhar com erro de auth: confirmar que `OPENROUTER_API_KEY` está mesmo setada no container. Se `Parse LLM JSON` falhar com `JSON.parse` inválido: o modelo devolveu texto fora do JSON pedido — abrir a saída bruta do `Call OpenRouter` e ajustar o prompt reforçando "responda SOMENTE em JSON".

Depois de conferir, restaurar o `Execute Workflow Trigger` original (ver Procedimento acima).

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
        "query": "SELECT vr.script_text AS script_text, n.voice_id AS voice_id FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-read-script-voice",
      "name": "Read script and voice",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { text: $json.script_text, voice: $json.voice_id } }];"
      },
      "id": "code-build-tts",
      "name": "Build TTS request",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [680, 300]
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
      "position": [900, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const TTS_BASE = 'http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io';\nreturn [{ json: { voice_url: TTS_BASE + $json.url, run_id: $node[\"Execute Workflow Trigger\"].json.run_id } }];"
      },
      "id": "code-absolute-url",
      "name": "Build absolute URL",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET voice_url = $1, current_step = 'voz', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "voice_url,run_id" }
      },
      "id": "pg-save-voice",
      "name": "Save voice_url",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1340, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read script and voice", "type": "main", "index": 0 }]] },
    "Read script and voice": { "main": [[{ "node": "Build TTS request", "type": "main", "index": 0 }]] },
    "Build TTS request": { "main": [[{ "node": "Call tts-service", "type": "main", "index": 0 }]] },
    "Call tts-service": { "main": [[{ "node": "Build absolute URL", "type": "main", "index": 0 }]] },
    "Build absolute URL": { "main": [[{ "node": "Save voice_url", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota de design: `Read script and voice` usa **1 query com `JOIN`** entre `video_runs` e `niches` em vez de 2 nodes Postgres sequenciais — evita o problema de `queryParams` só enxergar campos do item atual (se fossem 2 nodes, o segundo precisaria de `niche_id`, que não sobra no item depois do primeiro `SELECT script_text`).

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/voz.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/voz.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/voz.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$VOZ_ID`. Ativar.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id` de teste do Task 1 (já tem `script_text` preenchido). Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$VOZ_ID`, executar via MCP.

Expected: `success: true`, `voice_url` salvo é uma URL absoluta terminando em `.wav`. Validado nesta sessão: `curl -sI` na URL retornou `200`, `Content-Type: audio/x-wav`, ~1.7MB pra ~40s de fala — confirma áudio real gerado pelo Piper TTS.

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
        "additionalFields": { "queryParams": "run_id" }
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
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ json: { captions: JSON.stringify($json.segments), run_id: $node[\"Execute Workflow Trigger\"].json.run_id } }];"
      },
      "id": "code-build-captions",
      "name": "Build captions params",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET captions_json = $1, current_step = 'legenda', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "captions,run_id" }
      },
      "id": "pg-save-captions",
      "name": "Save captions",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read voice_url", "type": "main", "index": 0 }]] },
    "Read voice_url": { "main": [[{ "node": "Call whisper-service", "type": "main", "index": 0 }]] },
    "Call whisper-service": { "main": [[{ "node": "Build captions params", "type": "main", "index": 0 }]] },
    "Build captions params": { "main": [[{ "node": "Save captions", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Nota de design: `Build captions params` existe só pra colocar `run_id` (que só existe no trigger) no mesmo item que `captions` (que vem da resposta HTTP), já que `Save captions` (Postgres) só consegue ler campos do item imediatamente anterior via `queryParams`.

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/legenda.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/legenda.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/legenda.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$LEGENDA_ID`. Ativar.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id` de teste (já tem `voice_url` preenchido pelo Task 2). Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$LEGENDA_ID`, executar via MCP.

Expected: `success: true`, `captions_json` salvo é um array de objetos `{"text","start","end"}` cobrindo a duração inteira do áudio (validado nesta sessão: 14 segments, 0s a ~39.7s). Se `Call whisper-service` retornar 401: confirmar `WHISPER_AUTH_TOKEN` no env do n8n. A transcrição do `whisper-service` (`WHISPER_MODEL_SIZE=base`) comete alguns erros pontuais em português (ex. "beijar" no lugar de "veja", "Me são comprida" no lugar de "Missão cumprida") — aceitável pro MVP, captions são só visuais e não afetam a voz já gravada pelo Piper.

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

Substituir `<run_id de teste>` por um valor literal (número inteiro) antes de registrar — é substituição de texto na query SQL, não `queryParams` do n8n (mais simples pra um workflow de uso único).

```json
{
  "name": "Postador - Check Run (descartável)",
  "nodes": [
    { "parameters": { "rule": { "interval": [{ "field": "days", "daysInterval": 365 }] } }, "id": "trigger-1", "name": "Schedule Trigger", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [240, 300] },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT id, current_step, topic, script_text, voice_url, jsonb_array_length(captions_json) AS n_captions FROM postador.video_runs WHERE id = <run_id de teste>;"
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

Expected: 1 linha com `current_step = 'legenda'`, `topic` e `script_text` coerentes com a persona, `voice_url` terminando em `.wav`, `n_captions` > 0. Validado nesta sessão: `current_step='legenda'`, `topic='Operação Compartilhar Alegria'`, `n_captions=14`. Isso confirma que os 3 sub-workflows compõem corretamente sobre o mesmo `run_id`, sem passar payload gigante entre eles (só leram/escreveram a mesma linha).

- [ ] **Step 4: Apagar o workflow descartável**

```bash
curl -s -X DELETE "$N8N_BASE/api/v1/workflows/<id retornado no Step 2>" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Não commitar `n8n-workflows/_check-run.json`.

---

## Self-Review

- **Cobertura**: implementa os itens 1-3 da seção "Arquitetura de Workflows" do spec (Roteiro, Voz, Legenda), incorporando a correção de contrato real dos microserviços (audioUrl, captions=segments, URL relativa do tts-service) e o fix de `{{topic}}` indevido no prompt (feito no plano de fundações antes deste). ✅ **Validado com execução real via MCP nesta sessão**, não só revisão de código.
- **Sem placeholders de lógica**: todo Code node tem JS completo, toda query SQL é literal e parametrizada corretamente (`queryParams` como nomes de campo, confirmado funcionando). Únicos placeholders são segredo/instância (`__PG_CRED_ID__`) com padrão de substituição explícito. ✅
- **Consistência de tipos**: `run_id`/`niche_id` sempre acessados via `$node["Execute Workflow Trigger"].json` dentro de Code nodes; nodes Postgres sempre leem campos do item imediatamente anterior (nunca cross-node). Nome de coluna `captions_json` usado de forma idêntica aqui e no plano de fundações. ✅
- **Risco conhecido**: `response_format: json_object` foi deliberadamente **não usado** na chamada OpenRouter (suporte varia por modelo/provedor via OpenRouter) — a robustez vem do prompt ("responda SOMENTE em JSON") + parsing tolerante a cercas de markdown no `Parse LLM JSON`. Funcionou nas 2 execuções de teste desta sessão. Se o modelo `deepseek/deepseek-chat` ficar instável, trocar só o campo `model` no `jsonBody` do node `Call OpenRouter` — nada mais muda. ✅
- **Bug real encontrado e corrigido nesta execução**: a primeira versão deste plano usava `"queryParams": "={{$json.campo}}"` (expression) em vez de `"queryParams": "campo"` (nome literal) — isso falhava com `propertiesString.split is not a function`. Corrigido em todos os 3 workflows + no procedimento de teste (nome do node de trigger preservado). Ver "Achados da execução" no topo deste documento. ✅
