# n8n Assets + Render (+ render-service /thumbnail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar os sub-workflows **Assets** (busca clipes + escolhe música) e **Render** (chama `render-service` pros 2 formatos de vídeo + thumbnail). Como pré-requisito descoberto nesta sessão, `render-service` precisa ganhar um endpoint novo `/thumbnail` — o spec original previa "mascote + texto da missão" mas isso nunca foi implementado no serviço já publicado.

**Architecture:** `render-service` ganha `POST /thumbnail` (Node/ffmpeg `drawtext`, mesmo binário ffmpeg já instalado no container — sem dependência nova) que compõe `mascot_image_url` + texto da missão numa imagem estática, reaproveitando o padrão de download-pra-tmp já usado em `/render`. No n8n, Assets busca clipes via Pexels (fallback Pixabay) e escolhe música de uma lista curada fixa (Pixabay **não tem API pública de música/áudio** — confirmado nesta sessão, só imagens/vídeos — por isso a trilha sonora é um punhado de faixas pré-carregadas, servidas pelo próprio `render-service` via sua rota estática `/files` já existente). Render lê os assets gravados pelo Assets, chama `/render` e `/thumbnail`, grava as 3 URLs de volta em `video_runs`.

**Tech Stack:** `ffmpeg` (`drawtext` filter), Pexels Videos API, Pixabay Videos API (fallback), node Postgres/HTTP Request/Code do n8n.

**Pré-requisito:** Planos `2026-07-16-n8n-foundations.md` (schema com `assets_json`/`music_url`/`captions_json` já criado) e `2026-07-16-n8n-roteiro-voz-legenda.md` executados — o `run_id` de teste já tem `script_text`, `voice_url`, `captions_json` preenchidos.

## Achados da execução do plano de fundações (aplicar em todo registro/teste deste plano)

- **Atualizar workflow via API é `PUT /api/v1/workflows/{id}`, não `PATCH`** (`PATCH` retorna 405). `PUT` substitui o objeto inteiro — sempre reenviar `name`, `nodes`, `connections`, `settings` completos.
- **`mcp__n8n__execute_workflow` só executa workflows com trigger `Schedule Trigger`, `Webhook Trigger`, `Form Trigger` ou `Chat Trigger`** — `Execute Workflow Trigger` não está nessa lista, e o workflow precisa `active: true` + `settings.availableInMCP: true` (nenhum default). Cada workflow deste plano já nasce com `"settings": {"availableInMCP": true}`.
- **Procedimento de Teste Isolado via MCP**: trocar temporariamente o `Execute Workflow Trigger` por `Schedule Trigger` + `Code` node hardcodando `{run_id, niche_id}` de teste, testar, restaurar o original depois. ⚠️ **O Code node de substituição precisa manter o nome exato `"Execute Workflow Trigger"`** — qualquer node adiante que referencie `$node["Execute Workflow Trigger"]` quebra com `"Referenced node doesn't exist"` se o node de teste tiver outro nome.

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

- ⚠️ **`additionalFields.queryParams` do node Postgres NÃO é uma expression `{{ }}`** — é uma string literal separada por vírgula com **nomes de campo do item de entrada atual** (`item.json[nome]`, confirmado lendo o código-fonte do node). O plano original usava `"={{$json.niche_id}}"` (expression) — **errado**, falha com `"propertiesString.split is not a function"`. Correto: `"niche_id"` (nome puro). Isso também significa que `queryParams` **nunca** pode referenciar outro node (`$node[...]` não funciona ali) — só o item imediatamente anterior. Onde o valor precisa vir de mais de uma fonte (ex. dado de `video_runs` + `niches`), resolver com **1 query usando `JOIN`**; onde precisa "atravessar" uma chamada HTTP (perdendo campos), usar um Code node logo antes da escrita que remonta um item plano com exatamente os nomes citados em `queryParams`, puxando de `$node[...]` (Code node pode referenciar qualquer node livremente, só `queryParams` não pode). Os JSONs abaixo já aplicam essas correções.
- **Node Postgres sem `RETURNING` devolve 0 linhas** — se tiver node depois na cadeia, precisa de `"alwaysOutputData": true`. Não se aplica aos sub-workflows deste plano (queries sem `RETURNING` já são o último node de cada cadeia).

---

## Task 1: `render-service` — novo endpoint `POST /thumbnail`

**Files:**
- Create: `render-service/src/download.js`
- Modify: `render-service/src/compose.js`
- Modify: `render-service/src/render.js`
- Modify: `render-service/src/server.js`
- Test: `render-service/src/__tests__/compose.test.js`
- Test: `render-service/src/__tests__/render.test.js`
- Test: `render-service/src/__tests__/server.test.js`

- [ ] **Step 1: Extrair `downloadToTmp` pra módulo próprio (usado por `/render` e `/thumbnail`)**

```js
// render-service/src/download.js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function downloadToTmp(url, destDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const destPath = path.join(destDir, `${crypto.randomUUID()}-${path.basename(new URL(url).pathname)}`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

module.exports = { downloadToTmp };
```

- [ ] **Step 2: Escrever teste que falha pra `escapeDrawtext`/`buildThumbnailArgs` em `compose.test.js`** (adicionar ao final do arquivo existente)

```js
const { escapeDrawtext, buildThumbnailArgs } = require('../compose');

test('escapeDrawtext escapes colon, backslash and replaces apostrophe', () => {
  assert.equal(escapeDrawtext(`It's 10:30\\done`), 'It’s 10\\:30\\\\done');
});

test('buildThumbnailArgs builds a single-frame ffmpeg overlay command', () => {
  const args = buildThumbnailArgs('mascot.png', 'Missão Super Ouvidos', 'out.jpg');
  assert.deepEqual(args.slice(0, 2), ['-i', 'mascot.png']);
  const filterIndex = args.indexOf('-vf');
  assert.ok(filterIndex !== -1);
  assert.match(args[filterIndex + 1], /drawtext=text='Miss.*Super Ouvidos'/);
  assert.deepEqual(args.slice(-4), ['-frames:v', '1', '-q:v', '2']);
  assert.equal(args.at(-1) === 'out.jpg' || args.includes('out.jpg'), true);
});
```

- [ ] **Step 3: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `escapeDrawtext is not a function` (não exportado ainda).

- [ ] **Step 4: Implementar em `compose.js`** (adicionar ao final do arquivo, antes do `module.exports`)

```js
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')
    .replace(/%/g, '\\%');
}

function buildThumbnailArgs(mascotPath, text, outPath) {
  const escaped = escapeDrawtext(text);
  const drawtext = `drawtext=text='${escaped}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-160:box=1:boxcolor=black@0.5:boxborderw=20`;
  return ['-i', mascotPath, '-vf', drawtext, '-frames:v', '1', '-q:v', '2', '-y', outPath];
}
```

Atualizar o `module.exports` de `compose.js` pra incluir `escapeDrawtext, buildThumbnailArgs`:

```js
module.exports = { buildFfmpegArgs, buildSrt, writeSrt, srtTimestamp, FORMATS, escapeDrawtext, buildThumbnailArgs };
```

- [ ] **Step 5: Rodar, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS nos 2 testes novos.

- [ ] **Step 6: Escrever teste que falha pra `renderThumbnail` em `render.test.js`** (adicionar ao final)

```js
const { renderThumbnail } = require('../render');

test('renderThumbnail calls ffmpeg once and returns the output path', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push(args);
    cb(null, '', '');
  };
  const outPath = await renderThumbnail({ jobId: 'job1', mascotPath: 'mascot.png', text: 'Missão Teste' }, outDir, fakeExecFile);
  assert.equal(calls.length, 1);
  assert.equal(outPath, path.join(outDir, 'job1-thumb.jpg'));
});
```

- [ ] **Step 7: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `renderThumbnail is not a function`.

- [ ] **Step 8: Implementar `renderThumbnail` em `render.js`**

```js
// render-service/src/render.js — adicionar no topo o import de buildThumbnailArgs
const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildFfmpegArgs, writeSrt, buildThumbnailArgs } = require('./compose');

// ... (runFfmpeg e renderJob permanecem iguais) ...

async function renderThumbnail(job, outDir, execFileImpl = execFile) {
  const outPath = path.join(outDir, `${job.jobId}-thumb.jpg`);
  const args = buildThumbnailArgs(job.mascotPath, job.text, outPath);
  await runFfmpeg(args, execFileImpl);
  return outPath;
}

module.exports = { runFfmpeg, renderJob, renderThumbnail };
```

- [ ] **Step 9: Rodar todos os testes, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS em todos.

- [ ] **Step 10: Escrever testes que falham pra rota `/thumbnail` em `server.test.js`** (adicionar ao final)

```js
test('POST /thumbnail without auth returns 401', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  server.close();
});

test('POST /thumbnail with auth but missing fields returns 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /thumbnail with path-traversal jobId returns 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ jobId: '../../etc/passwd', mascotImageUrl: 'http://example.com/m.png', text: 'x' }),
  });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /thumbnail returns a generic error and does not leak internal details on failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, ...args) => {
    if (typeof url === 'string' && url.includes('127.0.0.1')) {
      return originalFetch(url, ...args);
    }
    throw new Error("ENOENT: no such file or directory, open '/data/renders/secret-internal-path'");
  };
  try {
    const server = await listen(app);
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/thumbnail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ jobId: 'job-thumb-500', mascotImageUrl: 'http://example.com/m.png', text: 'Missão Teste' }),
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.deepEqual(body, { error: 'thumbnail failed' });
    server.close();
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 11: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `/thumbnail` retorna 404 (rota não existe ainda).

- [ ] **Step 12: Implementar a rota em `server.js`**

```js
// render-service/src/server.js — trocar o downloadToTmp local pelo import do módulo novo
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { renderJob, renderThumbnail } = require('./render');
const { downloadToTmp } = require('./download');

// remover a função downloadToTmp local (agora vem de ./download)

// ... app.post('/render', ...) permanece igual ...

app.post('/thumbnail', requireAuth, async (req, res) => {
  const { jobId, mascotImageUrl, text } = req.body || {};
  if (
    !jobId ||
    typeof jobId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(jobId) ||
    !mascotImageUrl ||
    !text ||
    typeof text !== 'string'
  ) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  const jobDir = path.join(RENDERS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const mascotPath = await downloadToTmp(mascotImageUrl, jobDir);
    const outPath = await renderThumbnail({ jobId, mascotPath, text }, jobDir);
    res.json({ jobId, url: `/files/${jobId}/${path.basename(outPath)}` });
  } catch (err) {
    console.error(`thumbnail failed for job ${jobId}:`, err);
    res.status(500).json({ error: 'thumbnail failed' });
  }
});

app.use('/files', express.static(RENDERS_DIR));
```

Nota: `crypto`/`path.basename(new URL(...))` que antes estavam soltos em `server.js` só existiam por causa do `downloadToTmp` local — como ele virou import de `./download`, remover os `require`s que ficarem sem uso (`crypto`) e manter `path`/`fs` (ainda usados pelas rotas).

- [ ] **Step 13: Rodar todos os testes, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS em todos (`/render` inalterado + `/thumbnail` novo).

- [ ] **Step 14: Commit**

```bash
git add render-service/src/download.js render-service/src/compose.js render-service/src/render.js render-service/src/server.js render-service/src/__tests__/compose.test.js render-service/src/__tests__/render.test.js render-service/src/__tests__/server.test.js
git commit -m "feat(render-service): add /thumbnail endpoint (mascot + mission text overlay via ffmpeg drawtext)"
```

- [ ] **Step 15: Redeploy no Coolify**

```bash
git push origin main
COOLIFY_BASE="http://137.131.180.11:8000"
TOKEN="<obter com o operador — não versionar>"
curl -s "$COOLIFY_BASE/api/v1/deploy?uuid=hdc4uggio012w03s44k1f4e3" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200` com `deployment_uuid`. Aguardar app voltar a `running`.

- [ ] **Step 16: Smoke test real**

```bash
RENDER_AUTH_TOKEN="<valor atual configurado no Coolify>"
curl -s -X POST http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/thumbnail \
  -H "Authorization: Bearer $RENDER_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"jobId":"smoke-thumb-1","mascotImageUrl":"<URL pública de uma imagem qualquer pra teste>","text":"Missão Super Ouvidos"}'
```

Expected: `200`, JSON `{"jobId":"smoke-thumb-1","url":"/files/smoke-thumb-1/....jpg"}`. Baixar a URL completa (`http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io` + `url`) e abrir a imagem — conferir o texto sobreposto legível na imagem de teste.

---

## Task 2: Curar faixas de música fixas (trilha sonora)

**Contexto:** Pixabay **não tem API pública de música/áudio** (só imagens e vídeos, confirmado via busca nesta sessão) — diferente do que o spec original assumia. Solução MVP: um punhado de faixas royalty-free baixadas manualmente uma única vez, hospedadas pelo próprio `render-service` (que já serve arquivos estáticos em `/files`).

**Files:** nenhum arquivo de código — upload manual de arquivos.

- [x] **Step 1: Baixar 3-5 faixas instrumentais royalty-free** (ex. Pixabay Music via navegador, licença permite uso livre até sem atribuição conforme a licença do site — checar a licença de cada faixa individualmente na página de download) em `.mp3`, curtas (60-90s, looping-friendly), tom alegre/infantil coerente com o nicho.

**Concluído em 2026-07-18, com desvio**: Pixabay bloqueia scraping automatizado do site de música (403), sem API pública pra música (só imagens/vídeos). Fonte usada: incompetech.com (Kevin MacLeod), URLs diretas de mp3 estáveis, sem bloqueio de bot. Licença **CC-BY 4.0** (com atribuição), não "sem atribuição" como esperado do Pixabay — ver pendência de atribuição no Publish abaixo. 5 faixas baixadas: Wallpaper, Merry Go, Carefree, Happy Boy Theme, Pixel Peeker Polka - faster (durações variam, todas bem acima dos 40s do vídeo — sem problema, `amix duration=first` em `compose.js` corta a música na duração da voz, não precisa looping).

- [x] **Step 2: Subir os arquivos pro volume persistente do `render-service`** (`RENDERS_DIR`, que é servido em `/files`)

**Concluído em 2026-07-18**: sem acesso SSH à VPS (publickey negado) e sem `docker cp` viável — upload feito de dentro do próprio container via Coolify Terminal, rodando um script `node -e` (Node sempre presente na imagem, sem depender de `curl`/`wget` que a imagem `node:22-slim` não garante) que baixou os 5 mp3 direto de incompetech.com pra `/data/renders/music/track{1..5}.mp3`.

- [x] **Step 3: Confirmar acessível publicamente**

```bash
curl -sI http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track1.mp3
```

Expected: `200`, `content-type: audio/mpeg`. **Confirmado em 2026-07-18 pras 5 faixas** (`200`, `audio/mpeg`, `content-length` batendo com os arquivos baixados).

- [x] **Step 4: Anotar as URLs finais**

Guardar a lista de URLs em `docs/superpowers/plans/n8n-instance.local.md` (mesmo arquivo local do plano de fundações) — usada como lista fixa no Code node do Assets sub-workflow (Task 4 abaixo). **Feito**: node "Pick music" do workflow `hvC6AtEMoD7B3BuX` atualizado direto na UI do n8n com as 5 URLs (evitando `PUT` via API, que exigiria reconstruir o workflow inteiro sem visibilidade das credenciais Postgres já configuradas nos nodes — risco de perdê-las).

---

## Task 3: Sub-workflow Assets

**Files:**
- Create: `n8n-workflows/assets.json`

- [ ] **Step 1: Escrever `n8n-workflows/assets.json`**

```json
{
  "name": "Postador - Assets",
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
        "query": "SELECT clip_keywords FROM postador.niches WHERE id = $1;",
        "additionalFields": { "queryParams": "niche_id" }
      },
      "id": "pg-read-keywords",
      "name": "Read niche assets config",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const keywords = $json.clip_keywords || [];\nreturn keywords.map(keyword => ({ json: { keyword } }));"
      },
      "id": "code-split-keywords",
      "name": "Split keywords",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [680, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.pexels.com/videos/search?query={{ encodeURIComponent($json.keyword) }}&per_page=2&orientation=landscape",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "Authorization", "value": "={{$env.PEXELS_API_KEY}}" }]
        },
        "options": {}
      },
      "id": "http-pexels",
      "name": "Search Pexels",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const clips = [];\nfor (const item of $input.all()) {\n  const videos = item.json.videos || [];\n  for (const video of videos) {\n    const files = video.video_files || [];\n    const best = files.find(f => f.quality === 'hd' && f.file_type === 'video/mp4') || files.find(f => f.file_type === 'video/mp4') || files[0];\n    if (best) clips.push({ url: best.link });\n  }\n}\nif (clips.length === 0) {\n  const pixabayKey = $env.PIXABAY_API_KEY;\n  const res = await this.helpers.httpRequest({\n    method: 'GET',\n    url: `https://pixabay.com/api/videos/?key=${pixabayKey}&q=family&per_page=6`,\n    json: true,\n  });\n  for (const hit of (res.hits || [])) {\n    const v = (hit.videos && (hit.videos.medium || hit.videos.large || hit.videos.small)) || null;\n    if (v && v.url) clips.push({ url: v.url });\n  }\n}\nreturn [{ json: { clips } }];"
      },
      "id": "code-flatten-clips",
      "name": "Flatten clip candidates",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const MUSIC_TRACKS = [\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track1.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track2.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track3.mp3'\n];\nconst musicUrl = MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)];\nreturn [{ json: { clipsJson: JSON.stringify($json.clips), musicUrl, run_id: $node[\"Execute Workflow Trigger\"].json.run_id } }];"
      },
      "id": "code-pick-music",
      "name": "Pick music",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET assets_json = $1, music_url = $2, current_step = 'assets', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "clipsJson,musicUrl,run_id" }
      },
      "id": "pg-save-assets",
      "name": "Save assets",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read niche assets config", "type": "main", "index": 0 }]] },
    "Read niche assets config": { "main": [[{ "node": "Split keywords", "type": "main", "index": 0 }]] },
    "Split keywords": { "main": [[{ "node": "Search Pexels", "type": "main", "index": 0 }]] },
    "Search Pexels": { "main": [[{ "node": "Flatten clip candidates", "type": "main", "index": 0 }]] },
    "Flatten clip candidates": { "main": [[{ "node": "Pick music", "type": "main", "index": 0 }]] },
    "Pick music": { "main": [[{ "node": "Save assets", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

Ajustar as 3 URLs de `MUSIC_TRACKS` no node `Pick music` com as URLs reais confirmadas no Task 2 antes de registrar (se os nomes de arquivo finais forem diferentes de `track1.mp3`/`track2.mp3`/`track3.mp3`).

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/assets.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/assets.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/assets.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$ASSETS_ID`.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id`/`niche_id` de teste. Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$ASSETS_ID`, executar via MCP.

Expected: execução verde, `assets_json` salvo é um array de `{"url": "..."}` (várias entradas, uma por vídeo Pexels encontrado por keyword), `music_url` é uma das 3 faixas fixas. Se `Search Pexels` retornar `401`: checar `PEXELS_API_KEY` no env do n8n. Se `clips` vier vazio mesmo com o fallback: checar `PIXABAY_API_KEY` e testar a URL do Pixabay manualmente via curl.

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/assets.json
git commit -m "feat(n8n): add Assets sub-workflow (Pexels clips + fallback + fixed music tracks)"
```

---

## Task 4: Sub-workflow Render

**Files:**
- Create: `n8n-workflows/render.json`

**Pré-requisito:** o nicho de teste precisa de `mascot_image_url` preenchido (o mascote final ainda pode não estar pronto — usar qualquer URL pública de imagem estática só pra validar o pipeline, trocar depois pela arte real):

```sql
UPDATE postador.niches SET mascot_image_url = '<URL de imagem de teste>' WHERE id = <niche_id de teste>;
```

Rodar isso através do mesmo padrão do workflow descartável `_check-run.json` do plano anterior (trocar a query) ou de qualquer node Postgres de teste.

- [ ] **Step 1: Escrever `n8n-workflows/render.json`**

```json
{
  "name": "Postador - Render",
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
        "query": "SELECT vr.voice_url, vr.captions_json, vr.assets_json, vr.music_url, vr.topic, n.mascot_image_url FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-read-run",
      "name": "Read run and niche",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const run = $json;\nconst clips = typeof run.assets_json === 'string' ? JSON.parse(run.assets_json) : run.assets_json;\nconst captions = typeof run.captions_json === 'string' ? JSON.parse(run.captions_json) : run.captions_json;\nreturn [{ json: { jobId: 'run-' + $node[\"Execute Workflow Trigger\"].json.run_id, clips, voiceUrl: run.voice_url, musicUrl: run.music_url, captions, mascotImageUrl: run.mascot_image_url, topic: run.topic, run_id: $node[\"Execute Workflow Trigger\"].json.run_id } }];"
      },
      "id": "code-build-render-job",
      "name": "Build render job",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [900, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/render",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "Authorization", "value": "=Bearer {{$env.RENDER_AUTH_TOKEN}}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { jobId: $json.jobId, clips: $json.clips, voiceUrl: $json.voiceUrl, musicUrl: $json.musicUrl, captions: $json.captions } }}",
        "options": {}
      },
      "id": "http-render",
      "name": "Call render-service /render",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const RENDER_BASE = 'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io';\nconst src = $node[\"Build render job\"].json;\nreturn [{ json: { render16x9: RENDER_BASE + $json.files['16:9'], render9x16: RENDER_BASE + $json.files['9:16'], jobId: src.jobId, mascotImageUrl: src.mascotImageUrl, topic: src.topic, run_id: src.run_id } }];"
      },
      "id": "code-build-render-urls",
      "name": "Build absolute render URLs",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/thumbnail",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{ "name": "Authorization", "value": "=Bearer {{$env.RENDER_AUTH_TOKEN}}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { jobId: $json.jobId, mascotImageUrl: $json.mascotImageUrl, text: $json.topic } }}",
        "options": {}
      },
      "id": "http-thumbnail",
      "name": "Call render-service /thumbnail",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1560, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const RENDER_BASE = 'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io';\nconst src = $node[\"Build absolute render URLs\"].json;\nreturn [{ json: { thumbnail_url: RENDER_BASE + $json.url, render16x9: src.render16x9, render9x16: src.render9x16, run_id: src.run_id } }];"
      },
      "id": "code-build-thumb-url",
      "name": "Build absolute thumbnail URL",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1780, 300]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET render_16x9_url = $1, render_9x16_url = $2, thumbnail_url = $3, current_step = 'render', updated_at = now() WHERE id = $4;",
        "additionalFields": { "queryParams": "render16x9,render9x16,thumbnail_url,run_id" }
      },
      "id": "pg-save-render",
      "name": "Save render results",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [2000, 300],
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read run and niche", "type": "main", "index": 0 }]] },
    "Read run and niche": { "main": [[{ "node": "Build render job", "type": "main", "index": 0 }]] },
    "Build render job": { "main": [[{ "node": "Call render-service /render", "type": "main", "index": 0 }]] },
    "Call render-service /render": { "main": [[{ "node": "Build absolute render URLs", "type": "main", "index": 0 }]] },
    "Build absolute render URLs": { "main": [[{ "node": "Call render-service /thumbnail", "type": "main", "index": 0 }]] },
    "Call render-service /thumbnail": { "main": [[{ "node": "Build absolute thumbnail URL", "type": "main", "index": 0 }]] },
    "Build absolute thumbnail URL": { "main": [[{ "node": "Save render results", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true }
}
```

- [ ] **Step 2: Substituir placeholder e registrar via API**

```bash
(Get-Content n8n-workflows/render.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/render.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/render.json.tmp
```

Expected: `200` com `id`. Anotar em `n8n-instance.local.md` como `$RENDER_ID`.

- [ ] **Step 3: Testar isolado**

Mesmo `run_id`/`niche_id` de teste (já tem `voice_url`, `captions_json`, `assets_json`, `music_url` preenchidos pelos planos/tasks anteriores; `niche_id` de teste já tem `mascot_image_url` do pré-requisito acima). Aplicar o "Procedimento de Teste Isolado via MCP" com `WORKFLOW_ID=$RENDER_ID`, executar via MCP.

Expected: execução verde, `render_16x9_url`/`render_9x16_url` terminando em `.mp4`, `thumbnail_url` terminando em `.jpg`. Baixar os 3 e conferir manualmente: vídeo com clipes+voz+música+legenda queimada, thumbnail com o mascote + texto do tema sobreposto e legível.

Nota de risco conhecida: a duração total dos clipes buscados pode ficar menor que a fala (Pexels/Pixabay não garantem duração mínima) — nesse caso o `-shortest` do ffmpeg corta a voz mais cedo. Se acontecer no teste, aumentar `per_page` no node `Search Pexels` (de `2` pra `4`) ou adicionar mais keywords em `postador.niches.clip_keywords`.

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/render.json
git commit -m "feat(n8n): add Render sub-workflow (render-service /render + /thumbnail)"
```

---

## Self-Review

- **Cobertura**: itens 4-5 da seção "Arquitetura de Workflows" do spec (Assets, Render), incluindo a lacuna real de thumbnail resolvida com um endpoint novo no serviço já publicado, e a lacuna de música (Pixabay não tem API) resolvida com faixas fixas servidas pelo próprio render-service. ✅
- **Sem placeholders de lógica**: endpoint `/thumbnail` com TDD completo (teste falho → implementação → teste passa), workflows n8n com Code nodes completos. Únicos placeholders reais são segredo/instância (`__PG_CRED_ID__`) e a lista de URLs de música (depende do upload manual do Task 2, documentado explicitamente como passo prévio). ✅
- **Consistência**: `run_id`/`niche_id` sempre via `$node["Execute Workflow Trigger"]`; `assets_json`/`captions_json` lidos com fallback `JSON.parse` defensivo caso o driver Postgres devolva string em vez de objeto já parseado. Nome de coluna e contrato batem com o que a Legenda/Assets gravaram no plano anterior. ✅
- **Risco conhecido documentado**: duração de clipes vs. duração da fala (sem garantia), variação de nomes de arquivo de música do Task 2 (ajustar antes de registrar o workflow). ✅

---

## Achados da execução deste plano (2026-07-17)

- **Task 1** executado via TDD (subagent-driven-development), com um refactor adicional pós-review (extrai `resolveJobDir` compartilhado entre `/render`/`/thumbnail`). Deploy real no Coolify + smoke test visual confirmado (mascote + texto "Missão Super Ouvidos" legível). Commits: `863afaa`, `59f037b` (cherry-picked pra `main` como `eaef7e0`/`604f9f1`).
- **Task 2 (música) ainda pendente** — não executado nesta sessão (é manual: baixar faixas, subir via terminal do Coolify). Workflow Assets já registrado com as 3 URLs placeholder (`track1/2/3.mp3`); ajustar se os nomes finais forem diferentes.
- **Task 3** (`assets.json`) implementado, revisado (spec+qualidade), com fix pós-review pra robustez (fallback Pixabay usa keyword real do nicho em vez de `q=family` fixo; `onError: continueRegularOutput` no Pexels + try/catch no fallback pra não abortar o sub-workflow inteiro numa falha de API externa). Registrado no n8n: `id = hvC6AtEMoD7B3BuX`. Testado isolado com run_id=1/niche_id=1: 8 clipes Pexels encontrados, `music_url` gravado corretamente.
- **Task 4** (`render.json`) implementado, revisado, com fix pós-review (timeout explícito de 600s no node HTTP do `/render`, ffmpeg pode ser lento). Registrado: `id = 7q2u4ySCyutTPGpC`.
- **Task 5 (novo, fora do escopo original, aprovado durante a execução)**: teste ao vivo do Render revelou bug real e pré-existente no `render-service` (da fase `render-whisper-services`, não desse plano): `buildFfmpegArgs` concatenava os clipes **inteiros** sem cortar pra duração da voz, gerando vídeo ~3x mais longo que a narração (125s de clipes vs. ~40s de fala). Corrigido: `renderJob` agora sonda a duração da voz via `ffprobe` (`getMediaDuration`, novo em `render.js`) e `buildFfmpegArgs` aplica `-t <duração>` antes do `-i` de cada clipe. TDD completo, revisado, aprovado (27/27 testes). Commit `f63d473` (cherry-picked pra `main` como `214b20a`).
- **Teste de ponta a ponta do Render incompleto** — mesmo com o fix da Task 5, um teste ao vivo subsequente (clipes Pexels reais, ~40s de voz, 8 clipes) levou ~58 minutos só pro formato 16:9 e produziu um `.mp4` sem átomo `moov` válido (sinal de processo morto antes de terminar, possível OOM na VPS ARM). Sem acesso a logs detalhados/SSH nesta sessão pra confirmar a causa raiz. **Ver armadilha equivalente em `CLAUDE.md`** — investigação de performance/memória do `/render` fica como item pendente separado, não bloqueia o encerramento deste plano (o *wiring* do sub-workflow Render está correto e revisado; o problema é de capacidade/infra do `render-service` em produção).
- **Procedimento de teste isolado revisado**: `mcp__n8n__execute_workflow` cancela a execução se ficar mais de ~300s sem resposta (mesmo que o workflow continue rodando no servidor) — usar **Webhook Trigger** (não Schedule Trigger) como gatilho de teste substituto pra jobs potencialmente longos (ex. Render), disparando via `curl -m <timeout longo>` direto, não via MCP. O `PUT` de restauração do trigger original precisa ser reconstruído a partir do JSON commitado (com placeholder substituído), não do dump bruto da API (`GET` traz campos extras como `createdAt`/`versionId` que o `PUT` rejeita com "must NOT have additional properties").
