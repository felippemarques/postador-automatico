# Melhoria de Roteiro, Duração e Thumbnail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separar o Roteiro em 2 histórias próprias (`script_long` 350-450 palavras pro 16:9, `script_short` 130-160 palavras pro Shorts) com estrutura de mini-história obrigatória, gerar `clip_keywords` por episódio (em vez de keywords estáticas do nicho), e corrigir o corte de texto na thumbnail com quebra de linha + fontsize dinâmico.

**Architecture:** `postador.video_runs` ganha colunas `_long`/`_short` (script, voice, captions, assets, music) + `clip_keywords`; os sub-workflows Voz/Legenda/Assets/Render passam a rodar 2x por run (parametrizados por `variant: 'long' | 'short'`), encadeados sequencialmente no Main Pipeline. `render-service` ganha wrap de texto + fontsize dinâmico na thumbnail, usando a largura real do mascote (`ffprobe`).

**Tech Stack:** Node.js/Express + FFmpeg (`render-service`), n8n workflows via API REST (`PUT /api/v1/workflows/{id}`), Postgres (schema `postador`), `node:test` para os testes do render-service.

**Design de referência:** `docs/superpowers/specs/2026-07-20-melhoria-roteiro-duracao-thumbnail-design.md` (aprovado). Este plano implementa esse design integralmente.

**Achados prévios que este plano precisa respeitar (não redescobrir — ver `docs/superpowers/plans/n8n-instance.local.md`):**
- Todo node Postgres terminal (sem `RETURNING`) precisa de `"alwaysOutputData": true`, senão a cadeia trava silenciosamente. Já corrigido ao vivo nos 7 sub-workflows, mas **nunca commitado nos arquivos locais** — como este plano reescreve esses arquivos, cada Save/Insert terminal abaixo já inclui `alwaysOutputData: true` pra não perder o fix.
- Os 7 sub-workflows têm `settings.errorWorkflow: "jwPN2t0n4jo5nXet"` linkado ao vivo, mas os arquivos locais só têm `availableInMCP: true`. Cada JSON abaixo já inclui os 2 campos de `settings` juntos.
- `PUT /api/v1/workflows/{id}` substitui o objeto inteiro — sempre fazer `GET` do workflow vivo primeiro, usar as credenciais reais de lá (não os placeholders `__PG_CRED_ID__`/`__TG_CRED_ID__`/`__YOUTUBE_CRED_ID__` dos arquivos locais, que são só pra leitura/versionamento), e nunca colar API key em texto puro na conversa (rodar os `curl` via `!` no terminal ou pedir pro usuário rodar).
- Node Postgres v1 não avalia `{{ }}` no campo `query` — sempre `$1,$2...` + `additionalFields.queryParams`.
- Assets (`hvC6AtEMoD7B3BuX`) e Render (`7q2u4ySCyutTPGpC`) nunca tiveram arquivo commitado no repo (foram registrados a partir de um `.tmp` gerado on-the-fly a partir do plano `2026-07-16-n8n-assets-render.md`, nunca versionado). Este plano cria `n8n-workflows/assets.json` e `n8n-workflows/render.json` pela primeira vez, reconstruídos a partir da versão viva atual (5 faixas de música reais, trim por `voiceDurationSec`) + as mudanças de variant.
- **Fora de escopo (herdado do design):** trocar o modelo do LLM; aumentar `per_page` do Pexels/Pixabay; aprovação separada por formato; thumbnail por variant. Adicionalmente, este plano **não** faz o `render-service` renderizar só 1 formato por chamada — cada chamada de `/render` continua gerando os 2 arquivos (16:9 e 9:16) como hoje, e o sub-workflow Render só persiste a URL do formato relevante ao variant, descartando o outro arquivo gerado (ineficiência aceita, mesma politica de "sem endpoint de exclusão" já registrada como pendência).

---

## Task 1: Migração de schema (`postador.video_runs`) — aditiva

**Files:**
- Modify: `sql/schema.sql`
- Create: `n8n-workflows/migracao-video-runs-variant.json`

- [ ] **Step 1: Atualizar `sql/schema.sql`**

Adicionar as novas colunas à tabela `video_runs` (mantendo as antigas por enquanto — remoção é Task 11):

```sql
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
  script_long_text TEXT,
  script_short_text TEXT,
  voice_long_url TEXT,
  voice_short_url TEXT,
  captions_long_json JSONB,
  captions_short_json JSONB,
  assets_long_json JSONB,
  assets_short_json JSONB,
  music_long_url TEXT,
  music_short_url TEXT,
  clip_keywords TEXT[],
  render_16x9_url TEXT,
  render_9x16_url TEXT,
  thumbnail_url TEXT,
  youtube_video_id TEXT,
  youtube_shorts_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Criar `n8n-workflows/migracao-video-runs-variant.json`**

Mesmo padrão descartável de `n8n-workflows/db-setup.json` (Schedule Trigger dummy, pra poder rodar via `mcp__n8n__execute_workflow` — `Execute Workflow Trigger` não roda por MCP):

```json
{
  "name": "Postador - Migração video_runs variant (descartável)",
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
        "query": "ALTER TABLE postador.video_runs\n  ADD COLUMN IF NOT EXISTS script_long_text TEXT,\n  ADD COLUMN IF NOT EXISTS script_short_text TEXT,\n  ADD COLUMN IF NOT EXISTS voice_long_url TEXT,\n  ADD COLUMN IF NOT EXISTS voice_short_url TEXT,\n  ADD COLUMN IF NOT EXISTS captions_long_json JSONB,\n  ADD COLUMN IF NOT EXISTS captions_short_json JSONB,\n  ADD COLUMN IF NOT EXISTS assets_long_json JSONB,\n  ADD COLUMN IF NOT EXISTS assets_short_json JSONB,\n  ADD COLUMN IF NOT EXISTS music_long_url TEXT,\n  ADD COLUMN IF NOT EXISTS music_short_url TEXT,\n  ADD COLUMN IF NOT EXISTS clip_keywords TEXT[];"
      },
      "id": "pg-ddl",
      "name": "Run DDL",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Schedule Trigger": { "main": [[{ "node": "Run DDL", "type": "main", "index": 0 }]] }
  },
  "settings": {}
}
```

- [ ] **Step 3: Registrar e rodar**

```bash
(Get-Content n8n-workflows/migracao-video-runs-variant.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/migracao-video-runs-variant.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/migracao-video-runs-variant.json.tmp
```

Expected: `200` com `id`. Anotar como `$MIGRATION_ID`. Rodar via `mcp__n8n__execute_workflow` com esse id.

Expected: execução verde. Confirmar via `SELECT column_name FROM information_schema.columns WHERE table_schema='postador' AND table_name='video_runs';` (rodar via qualquer node Postgres de teste, ou `mcp__n8n__execute_workflow` numa cópia de `_check` já usada em planos anteriores) que as 11 colunas novas existem.

- [ ] **Step 4: Desativar o workflow de migração**

Deixar `active: false` (o Schedule Trigger de 365 dias nunca dispararia sozinho, mas por clareza desativar via UI ou `PUT` com `active: false`).

- [ ] **Step 5: Commit**

```bash
git add sql/schema.sql n8n-workflows/migracao-video-runs-variant.json
git commit -m "feat(db): add long/short variant columns to video_runs (additive migration)"
```

---

## Task 2: `render-service` — thumbnail com quebra de linha e fontsize dinâmico

**Files:**
- Modify: `render-service/src/compose.js`
- Modify: `render-service/src/render.js`
- Test: `render-service/src/__tests__/compose.test.js`
- Test: `render-service/src/__tests__/render.test.js`

- [ ] **Step 1: Escrever os testes que falham em `compose.test.js`**

Substituir o teste `'buildThumbnailArgs builds a single-frame ffmpeg overlay command'` existente e adicionar os novos, no final do arquivo (depois do teste `'escapeDrawtext escapes percent signs'`):

```js
test('buildThumbnailArgs builds a single-frame ffmpeg overlay command for a short title (fits on one line)', () => {
  const args = buildThumbnailArgs('mascot.png', 'Oi Herói', 'out.jpg');
  assert.deepEqual(args.slice(0, 2), ['-i', 'mascot.png']);
  const filterIndex = args.indexOf('-vf');
  assert.ok(filterIndex !== -1);
  assert.match(args[filterIndex + 1], /drawtext=text='Oi Heró.*':fontsize=64/);
  assert.deepEqual(args.slice(-6), ['-frames:v', '1', '-q:v', '2', '-y', 'out.jpg']);
});

test('wrapTextToWidth wraps words into lines that fit maxCharsPerLine for the given fontsize/canvasWidth', () => {
  const lines = wrapTextToWidth('Missão Super Ouvidos Encantados', 64, 500);
  assert.ok(lines.length >= 2);
  const maxCharsPerLine = Math.floor((500 * 0.9) / (64 * 0.6));
  lines.forEach((line) => assert.ok(line.length <= maxCharsPerLine || !line.includes(' ')));
});

test('fitThumbnailText shrinks fontsize until the wrapped text fits within THUMBNAIL_MAX_LINES', () => {
  const { lines, fontsize } = fitThumbnailText('Missão Super Ouvidos', 500);
  assert.ok(fontsize < 64);
  assert.ok(lines.length <= 2);
});

test('fitThumbnailText never returns more lines for a longer canvasWidth than a shorter one', () => {
  const narrow = fitThumbnailText('Missão Guarda Brinquedos Encantados', 300);
  const wide = fitThumbnailText('Missão Guarda Brinquedos Encantados', 900);
  assert.ok(wide.fontsize >= narrow.fontsize);
});

test('buildThumbnailArgs wraps a long title into 2+ lines and/or shrinks fontsize so no line overflows canvasWidth', () => {
  const canvasWidth = 500;
  const args = buildThumbnailArgs('mascot.png', 'Missão Guarda Brinquedos Encantados', 'out.jpg', canvasWidth);
  const filter = args[args.indexOf('-vf') + 1];
  const fontsizeMatch = filter.match(/fontsize=(\d+)/);
  const fontsize = Number(fontsizeMatch[1]);
  const textMatch = filter.match(/text='([\s\S]*?)':fontsize=/);
  const lines = textMatch[1].split('\n');
  assert.ok(lines.length >= 2 || fontsize < 64);
  const maxCharsPerLine = Math.floor((canvasWidth * 0.9) / (fontsize * 0.6));
  lines.forEach((line) => assert.ok(line.length <= maxCharsPerLine + 1, `line "${line}" (${line.length} chars) exceeds estimated width at fontsize ${fontsize}`));
});

test('buildThumbnailArgs falls back to THUMBNAIL_DEFAULT_CANVAS_WIDTH when canvasWidth is omitted', () => {
  const withDefault = buildThumbnailArgs('mascot.png', 'Missão Super Ouvidos', 'out.jpg');
  const withExplicit500 = buildThumbnailArgs('mascot.png', 'Missão Super Ouvidos', 'out.jpg', 500);
  assert.equal(withDefault[withDefault.indexOf('-vf') + 1], withExplicit500[withExplicit500.indexOf('-vf') + 1]);
});
```

Atualizar o `require` no topo do arquivo:

```js
const { buildFfmpegArgs, srtTimestamp, buildSrt, escapeDrawtext, buildThumbnailArgs, wrapTextToWidth, fitThumbnailText } = require('../compose');
```

E remover o teste antigo `'buildThumbnailArgs builds a single-frame ffmpeg overlay command'` (substituído pelo de `'Oi Herói'` acima, que testa o mesmo contrato pro caso de 1 linha).

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
cd render-service && npm test
```

Expected: `FAIL` — `wrapTextToWidth`/`fitThumbnailText` não existem ainda (`TypeError: wrapTextToWidth is not a function` ou `undefined`), e o teste de `'Oi Herói'` falha porque `buildThumbnailArgs` ainda usa `fontsize=64` fixo sem os novos exports.

- [ ] **Step 3: Implementar em `compose.js`**

Substituir a função `buildThumbnailArgs` existente (linhas 102-106 do arquivo atual) por:

```js
const THUMBNAIL_MAX_FONTSIZE = 64;
const THUMBNAIL_MIN_FONTSIZE = 32;
const THUMBNAIL_MAX_LINES = 2;
const THUMBNAIL_CHAR_WIDTH_RATIO = 0.6;
const THUMBNAIL_MARGIN_RATIO = 0.9;
const THUMBNAIL_DEFAULT_CANVAS_WIDTH = 500;

// Estimates how many characters fit per line at a given fontsize/canvasWidth
// (no real font metrics available at this layer — a fixed average-glyph-width
// ratio is close enough for the default ffmpeg drawtext font) and greedily
// word-wraps the text to that width.
function wrapTextToWidth(text, fontsize, canvasWidth) {
  const maxCharsPerLine = Math.max(1, Math.floor((canvasWidth * THUMBNAIL_MARGIN_RATIO) / (fontsize * THUMBNAIL_CHAR_WIDTH_RATIO)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Shrinks fontsize (in steps of 8, down to THUMBNAIL_MIN_FONTSIZE) until the
// wrapped text fits within THUMBNAIL_MAX_LINES for the given canvasWidth.
function fitThumbnailText(text, canvasWidth) {
  for (let fontsize = THUMBNAIL_MAX_FONTSIZE; fontsize > THUMBNAIL_MIN_FONTSIZE; fontsize -= 8) {
    const lines = wrapTextToWidth(text, fontsize, canvasWidth);
    if (lines.length <= THUMBNAIL_MAX_LINES) return { lines, fontsize };
  }
  return { lines: wrapTextToWidth(text, THUMBNAIL_MIN_FONTSIZE, canvasWidth), fontsize: THUMBNAIL_MIN_FONTSIZE };
}

function buildThumbnailArgs(mascotPath, text, outPath, canvasWidth = THUMBNAIL_DEFAULT_CANVAS_WIDTH) {
  const { lines, fontsize } = fitThumbnailText(text, canvasWidth);
  const drawtextLines = lines.map(escapeDrawtext).join('\n');
  const drawtext = `drawtext=text='${drawtextLines}':fontsize=${fontsize}:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-160:line_spacing=10:box=1:boxcolor=black@0.5:boxborderw=20`;
  return ['-i', mascotPath, '-vf', drawtext, '-frames:v', '1', '-q:v', '2', '-y', outPath];
}
```

Atualizar o `module.exports` no final do arquivo:

```js
module.exports = { buildFfmpegArgs, buildSrt, writeSrt, srtTimestamp, FORMATS, escapeDrawtext, buildThumbnailArgs, wrapTextToWidth, fitThumbnailText };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
cd render-service && npm test
```

Expected: `PASS` em todos os testes de `compose.test.js`.

- [ ] **Step 5: Escrever os testes que falham em `render.test.js`**

Substituir o teste `'renderThumbnail calls ffmpeg once and returns the output path'` e adicionar os de `getImageWidth`:

```js
test('renderThumbnail probes mascot width via ffprobe, then calls ffmpeg once', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'ffprobe') return cb(null, '500\n', '');
    cb(null, '', '');
  };
  const outPath = await renderThumbnail({ jobId: 'job1', mascotPath: 'mascot.png', text: 'Missão Teste' }, outDir, fakeExecFile);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'ffprobe');
  assert.ok(calls[0].args.includes('mascot.png'));
  assert.equal(calls[1].cmd, 'ffmpeg');
  assert.equal(outPath, path.join(outDir, 'job1-thumb.jpg'));
});

test('getImageWidth resolves to the parsed integer width from ffprobe stdout', async () => {
  const fakeExecFile = (cmd, args, opts, cb) => cb(null, '500\n', '');
  const width = await getImageWidth('mascot.png', fakeExecFile);
  assert.equal(width, 500);
});

test('getImageWidth rejects with stderr message on failure', async () => {
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error('boom'), '', 'ffprobe error output');
  await assert.rejects(() => getImageWidth('mascot.png', fakeExecFile), /ffprobe error output/);
});
```

Atualizar o `require` no topo:

```js
const { renderJob, runFfmpeg, renderThumbnail, getMediaDuration, getImageWidth } = require('../render');
```

- [ ] **Step 6: Rodar os testes e confirmar que falham**

```bash
cd render-service && npm test
```

Expected: `FAIL` — `getImageWidth is not a function`, e o teste de `renderThumbnail` falha porque só 1 chamada (`ffmpeg`) acontece hoje, não 2.

- [ ] **Step 7: Implementar em `render.js`**

Adicionar depois de `getMediaDuration`:

```js
// Probes an image's pixel width via ffprobe. Used to size the thumbnail's
// word-wrap/fontsize to the mascot image's real width instead of a hardcoded
// canvasWidth.
function getImageWidth(filePath, execFileImpl = execFile) {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
  return new Promise((resolve, reject) => {
    execFileImpl('ffprobe', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffprobe failed: ${stderr || error.message}`));
      resolve(parseInt(stdout, 10));
    });
  });
}
```

Substituir `renderThumbnail`:

```js
async function renderThumbnail(job, outDir, execFileImpl = execFile) {
  const outPath = path.join(outDir, `${job.jobId}-thumb.jpg`);
  const canvasWidth = await getImageWidth(job.mascotPath, execFileImpl);
  const args = buildThumbnailArgs(job.mascotPath, job.text, outPath, canvasWidth);
  await runFfmpeg(args, execFileImpl);
  return outPath;
}
```

Atualizar o `require` de `compose` (já importa `buildThumbnailArgs`, sem mudança) e o `module.exports`:

```js
module.exports = { runFfmpeg, getMediaDuration, getImageWidth, renderJob, renderThumbnail };
```

- [ ] **Step 8: Rodar os testes e confirmar que passam**

```bash
cd render-service && npm test
```

Expected: `PASS` em todos os testes.

- [ ] **Step 9: Commit**

```bash
git add render-service/src/compose.js render-service/src/render.js render-service/src/__tests__/compose.test.js render-service/src/__tests__/render.test.js
git commit -m "fix(render-service): wrap thumbnail text and shrink fontsize to the mascot's real width"
```

- [ ] **Step 10: Deploy no Coolify**

`render-service` já está publicado (uuid da app provavelmente `hdc4uggio012w03s44k1f4e3`, mesmo subdomínio do endpoint — confirmar no painel Coolify antes de disparar, pode não ser o app uuid real):

```bash
curl -s "https://<coolify-host>/api/v1/deploy?uuid=<RENDER_APP_UUID>" -H "Authorization: Bearer <token>" -H "Accept: application/json"
```

Expected: deploy iniciado, `render-service` reiniciado com o código novo. Confirmar via `GET /health`.

---

## Task 3: Sub-workflow Roteiro (2 scripts + clip_keywords por episódio)

**Files:**
- Modify: `n8n-workflows/roteiro.json`

- [ ] **Step 1: Atualizar `prompt_template` do nicho de teste (niche_id=1)**

Rodar via node Postgres de teste (mesmo padrão de `_check` usado em planos anteriores) ou psql direto:

```sql
UPDATE postador.niches SET prompt_template = 'Você é o Capitão do Esquadrão da Gentileza, um herói animado e encorajador que ensina boas maneiras para crianças como se fossem superpoderes e missões. Invente você mesmo o tema de uma nova missão (nome curto, até 40 caracteres, ex: Missão Guarda-Brinquedos, Operação Ouvir os Pais, O Superpoder do Por Favor) que ainda NÃO esteja nesta lista de temas já usados: {{used_topics}}.

Escreva 2 roteiros em português do Brasil sobre esse tema, seguindo SEMPRE esta estrutura de mini-história: gancho inicial (uma pergunta ou frase que prende atenção) → situação concreta com um personagem enfrentando o desafio do dia → momento de decisão/virada → celebração final (a criança como herói). Nunca use tom de bronca (nada de "não faça X"), sempre celebre o poder da criança de deixar todo mundo mais feliz.

1. script_long: 350 a 450 palavras (~2-3 minutos falado), pode ter mais de uma cena/exemplo.
2. script_short: 130 a 160 palavras (~60-75 segundos falado), a mesma história condensada em 1 cena só.

Também gere clip_keywords: 4 a 6 termos de busca em inglês, específicos do tema do dia (para bibliotecas de vídeo em inglês como Pexels/Pixabay), ex: para "Missão Guarda-Brinquedos" use algo como ["child cleaning toys", "organizing room", "kid tidying up"].

Responda SOMENTE em JSON, sem markdown: {"topic": "nome curto da missão (até 40 caracteres)", "script_long": "...", "script_short": "...", "clip_keywords": ["...", "..."]}.' WHERE id = 1;
```

- [ ] **Step 2: Reescrever `n8n-workflows/roteiro.json`**

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
        "query": "SELECT id AS niche_id, prompt_template, voice_id, clip_keywords FROM postador.niches WHERE id = $1;",
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
        "jsCode": "const raw = $json.choices[0].message.content;\nconst cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();\nconst parsed = JSON.parse(cleaned);\nconst niche = $node[\"Read niche\"].json;\nconst clipKeywords = Array.isArray(parsed.clip_keywords) && parsed.clip_keywords.length > 0 ? parsed.clip_keywords : (niche.clip_keywords || []);\nreturn [{ json: { topic: parsed.topic, scriptLong: parsed.script_long, scriptShort: parsed.script_short, clipKeywords, run_id: $node[\"Execute Workflow Trigger\"].json.run_id, niche_id: $node[\"Execute Workflow Trigger\"].json.niche_id } }];"
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
        "query": "UPDATE postador.video_runs SET script_long_text = $1, script_short_text = $2, clip_keywords = $3, topic = $4, current_step = 'roteiro', updated_at = now() WHERE id = $5;",
        "additionalFields": { "queryParams": "scriptLong,scriptShort,clipKeywords,topic,run_id" }
      },
      "id": "pg-save-script",
      "name": "Save script",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 220],
      "alwaysOutputData": true,
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
      "alwaysOutputData": true,
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
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

- [ ] **Step 3: Aplicar ao vivo**

```bash
curl -s "$N8N_BASE/api/v1/workflows/WdwmATwH8cDbRVZO" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/roteiro-live.json
```

Editar `/tmp/roteiro-live.json`: substituir `nodes` e `connections` pelos do JSON acima (mantendo os `credentials` reais já presentes no arquivo vivo, não os placeholders), manter `settings` já vivo (já deve ter `errorWorkflow` + `availableInMCP`).

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/WdwmATwH8cDbRVZO" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/roteiro-live.json
```

Expected: `200`.

- [ ] **Step 4: Testar isolado**

Testar direto na UI do n8n (clicar no node "Execute Workflow Trigger", "Test workflow" com `{"run_id": 1, "niche_id": 1}` colado) — Roteiro usa `Execute Workflow Trigger`, então MCP não roda (achado de metodologia já registrado).

Expected: `video_runs.script_long_text` (350-450 palavras), `script_short_text` (130-160 palavras), `clip_keywords` (array de 4-6 termos em inglês) e `topic` preenchidos pro `run_id` de teste. Se `Call OpenRouter` devolver JSON malformado: checar se o prompt pede claramente "SOMENTE em JSON, sem markdown".

- [ ] **Step 5: Commit**

```bash
git add n8n-workflows/roteiro.json
git commit -m "feat(n8n): split Roteiro into script_long/script_short + episode clip_keywords"
```

---

## Task 4: Sub-workflow Voz (parametrizado por `variant`)

**Files:**
- Modify: `n8n-workflows/voz.json`

- [ ] **Step 1: Reescrever `n8n-workflows/voz.json`**

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
        "query": "SELECT CASE WHEN $2 = 'long' THEN vr.script_long_text ELSE vr.script_short_text END AS script_text, n.voice_id AS voice_id FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id,variant" }
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
        "jsCode": "const TTS_BASE = 'http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io';\nreturn [{ json: { voice_url: TTS_BASE + $json.url, run_id: $node[\"Execute Workflow Trigger\"].json.run_id, variant: $node[\"Execute Workflow Trigger\"].json.variant } }];"
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
        "query": "UPDATE postador.video_runs SET voice_long_url = CASE WHEN $2 = 'long' THEN $1 ELSE voice_long_url END, voice_short_url = CASE WHEN $2 = 'short' THEN $1 ELSE voice_short_url END, current_step = 'voz', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "voice_url,variant,run_id" }
      },
      "id": "pg-save-voice",
      "name": "Save voice_url",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1340, 300],
      "alwaysOutputData": true,
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
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

- [ ] **Step 2: Aplicar ao vivo**

```bash
curl -s "$N8N_BASE/api/v1/workflows/21MzrpQTSRFwh6Xa" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/voz-live.json
```

Substituir `nodes`/`connections` como no Step 3 da Task 3, manter `credentials` e `settings` reais.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/21MzrpQTSRFwh6Xa" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/voz-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `{"run_id": 1, "niche_id": 1, "variant": "long"}` e depois com `"variant": "short"`.

Expected: 1ª execução preenche `voice_long_url` (mantém `voice_short_url` como estava); 2ª execução preenche `voice_short_url` (mantém `voice_long_url` intocado).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/voz.json
git commit -m "feat(n8n): parametrize Voz by variant (long/short)"
```

---

## Task 5: Sub-workflow Legenda (parametrizado por `variant`)

**Files:**
- Modify: `n8n-workflows/legenda.json`

- [ ] **Step 1: Reescrever `n8n-workflows/legenda.json`**

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
        "query": "SELECT CASE WHEN $2 = 'long' THEN voice_long_url ELSE voice_short_url END AS voice_url FROM postador.video_runs WHERE id = $1;",
        "additionalFields": { "queryParams": "run_id,variant" }
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
        "jsCode": "return [{ json: { captions: JSON.stringify($json.segments), run_id: $node[\"Execute Workflow Trigger\"].json.run_id, variant: $node[\"Execute Workflow Trigger\"].json.variant } }];"
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
        "query": "UPDATE postador.video_runs SET captions_long_json = CASE WHEN $3 = 'long' THEN $1::jsonb ELSE captions_long_json END, captions_short_json = CASE WHEN $3 = 'short' THEN $1::jsonb ELSE captions_short_json END, current_step = 'legenda', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "captions,run_id,variant" }
      },
      "id": "pg-save-captions",
      "name": "Save captions",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1120, 300],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read voice_url", "type": "main", "index": 0 }]] },
    "Read voice_url": { "main": [[{ "node": "Call whisper-service", "type": "main", "index": 0 }]] },
    "Call whisper-service": { "main": [[{ "node": "Build captions params", "type": "main", "index": 0 }]] },
    "Build captions params": { "main": [[{ "node": "Save captions", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

- [ ] **Step 2: Aplicar ao vivo**

```bash
curl -s "$N8N_BASE/api/v1/workflows/K2582L7TX9s8wLci" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/legenda-live.json
```

Substituir `nodes`/`connections`, manter `credentials`/`settings` reais, `PUT` de volta.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/K2582L7TX9s8wLci" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/legenda-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `variant: "long"` (requer `voice_long_url` já preenchido pela Task 4) e depois `variant: "short"`.

Expected: `captions_long_json`/`captions_short_json` preenchidos respectivamente. Se o `UPDATE` der erro de tipo (`column "captions_long_json" is of type jsonb but expression is of type text` ou similar por causa do `CASE`/cast): confirmar que o `::jsonb` no `$1` dentro do CASE resolve; se não resolver, aplicar o cast no `ELSE` também (`ELSE captions_long_json` já é jsonb, não deveria precisar).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/legenda.json
git commit -m "feat(n8n): parametrize Legenda by variant (long/short)"
```

---

## Task 6: Sub-workflow Assets (clip_keywords por episódio + `variant`) — primeira versão commitada

**Files:**
- Create: `n8n-workflows/assets.json`

- [ ] **Step 1: Escrever `n8n-workflows/assets.json`**

Reconstruído a partir da versão viva atual (`hvC6AtEMoD7B3BuX`: 5 faixas reais de música, `Search Pexels`/fallback Pixabay inalterados) + as mudanças de variant + keywords por episódio:

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
        "query": "SELECT COALESCE(vr.clip_keywords, n.clip_keywords) AS clip_keywords FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id" }
      },
      "id": "pg-read-keywords",
      "name": "Read episode clip_keywords",
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
        "jsCode": "const MUSIC_TRACKS = [\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track1.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track2.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track3.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track4.mp3',\n  'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io/files/music/track5.mp3'\n];\nconst musicUrl = MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)];\nreturn [{ json: { clipsJson: JSON.stringify($json.clips), musicUrl, run_id: $node[\"Execute Workflow Trigger\"].json.run_id, variant: $node[\"Execute Workflow Trigger\"].json.variant } }];"
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
        "query": "UPDATE postador.video_runs SET assets_long_json = CASE WHEN $4 = 'long' THEN $1::jsonb ELSE assets_long_json END, assets_short_json = CASE WHEN $4 = 'short' THEN $1::jsonb ELSE assets_short_json END, music_long_url = CASE WHEN $4 = 'long' THEN $2 ELSE music_long_url END, music_short_url = CASE WHEN $4 = 'short' THEN $2 ELSE music_short_url END, current_step = 'assets', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "clipsJson,musicUrl,run_id,variant" }
      },
      "id": "pg-save-assets",
      "name": "Save assets",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 300],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read episode clip_keywords", "type": "main", "index": 0 }]] },
    "Read episode clip_keywords": { "main": [[{ "node": "Split keywords", "type": "main", "index": 0 }]] },
    "Split keywords": { "main": [[{ "node": "Search Pexels", "type": "main", "index": 0 }]] },
    "Search Pexels": { "main": [[{ "node": "Flatten clip candidates", "type": "main", "index": 0 }]] },
    "Flatten clip candidates": { "main": [[{ "node": "Pick music", "type": "main", "index": 0 }]] },
    "Pick music": { "main": [[{ "node": "Save assets", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

**Antes de aplicar ao vivo:** conferir no painel do n8n se os nomes/URLs das 5 faixas em `Pick music` (node vivo, atualizado em 2026-07-18) batem exatamente com o que está acima — usar os valores reais do node vivo, não confiar cegamente neste snapshot.

- [ ] **Step 2: Aplicar ao vivo**

```bash
curl -s "$N8N_BASE/api/v1/workflows/hvC6AtEMoD7B3BuX" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/assets-live.json
```

Conferir o node `Pick music` do `/tmp/assets-live.json` contra o do JSON acima (copiar as URLs reais se diferirem), substituir `nodes`/`connections`, manter `credentials`/`settings` reais, `PUT` de volta.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/hvC6AtEMoD7B3BuX" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/assets-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `{"run_id": 1, "niche_id": 1, "variant": "long"}` (requer `video_runs.clip_keywords` já preenchido pela Task 3) e depois `"variant": "short"`.

Expected: `assets_long_json`/`music_long_url` preenchidos na 1ª; `assets_short_json`/`music_short_url` na 2ª; clipes relevantes ao tema do episódio (não mais só os 4 termos estáticos do nicho).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/assets.json
git commit -m "feat(n8n): version Assets sub-workflow, read episode clip_keywords, parametrize by variant"
```

---

## Task 7: Sub-workflow Render (parametrizado por `variant`, thumbnail só no `long`) — primeira versão commitada

**Files:**
- Create: `n8n-workflows/render.json`

- [ ] **Step 1: Escrever `n8n-workflows/render.json`**

`jobId` ganha sufixo de variant (`run-<run_id>-<variant>`) pra não colidir entre as 2 chamadas do mesmo `run_id`. Uma `IF` node decide se roda o `/thumbnail` (só quando `variant === 'long'`), com 2 nodes de save distintos (o de `long` grava `thumbnail_url`, o de `short` não):

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
        "query": "SELECT CASE WHEN $2 = 'long' THEN vr.voice_long_url ELSE vr.voice_short_url END AS voice_url, CASE WHEN $2 = 'long' THEN vr.captions_long_json ELSE vr.captions_short_json END AS captions_json, CASE WHEN $2 = 'long' THEN vr.assets_long_json ELSE vr.assets_short_json END AS assets_json, CASE WHEN $2 = 'long' THEN vr.music_long_url ELSE vr.music_short_url END AS music_url, vr.topic, n.mascot_image_url FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
        "additionalFields": { "queryParams": "run_id,variant" }
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
        "jsCode": "const run = $json;\nconst clips = typeof run.assets_json === 'string' ? JSON.parse(run.assets_json) : run.assets_json;\nconst captions = typeof run.captions_json === 'string' ? JSON.parse(run.captions_json) : run.captions_json;\nconst variant = $node[\"Execute Workflow Trigger\"].json.variant;\nreturn [{ json: { jobId: 'run-' + $node[\"Execute Workflow Trigger\"].json.run_id + '-' + variant, clips, voiceUrl: run.voice_url, musicUrl: run.music_url, captions, mascotImageUrl: run.mascot_image_url, topic: run.topic, run_id: $node[\"Execute Workflow Trigger\"].json.run_id, variant } }];"
      },
      "id": "code-build-render-job",
      "name": "Build render job",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [680, 300]
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
      "position": [900, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "const RENDER_BASE = 'http://hdc4uggio012w03s44k1f4e3.137.131.180.11.sslip.io';\nconst src = $node[\"Build render job\"].json;\nreturn [{ json: { render16x9: RENDER_BASE + $json.files['16:9'], render9x16: RENDER_BASE + $json.files['9:16'], jobId: src.jobId, mascotImageUrl: src.mascotImageUrl, topic: src.topic, run_id: src.run_id, variant: src.variant } }];"
      },
      "id": "code-build-render-urls",
      "name": "Build absolute render URLs",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1120, 300]
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "loose" },
          "conditions": [
            {
              "id": "cond-is-long",
              "leftValue": "={{$json.variant}}",
              "rightValue": "long",
              "operator": { "type": "string", "operation": "equals" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-is-long",
      "name": "Is long variant?",
      "type": "n8n-nodes-base.if",
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
      "position": [1560, 200]
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
      "position": [1780, 200]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET render_16x9_url = $1, thumbnail_url = $2, current_step = 'render', updated_at = now() WHERE id = $3;",
        "additionalFields": { "queryParams": "render16x9,thumbnail_url,run_id" }
      },
      "id": "pg-save-render-long",
      "name": "Save render results (long, with thumbnail)",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [2000, 200],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "UPDATE postador.video_runs SET render_9x16_url = $1, current_step = 'render', updated_at = now() WHERE id = $2;",
        "additionalFields": { "queryParams": "render9x16,run_id" }
      },
      "id": "pg-save-render-short",
      "name": "Save render results (short)",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [1560, 420],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": { "main": [[{ "node": "Read run and niche", "type": "main", "index": 0 }]] },
    "Read run and niche": { "main": [[{ "node": "Build render job", "type": "main", "index": 0 }]] },
    "Build render job": { "main": [[{ "node": "Call render-service /render", "type": "main", "index": 0 }]] },
    "Call render-service /render": { "main": [[{ "node": "Build absolute render URLs", "type": "main", "index": 0 }]] },
    "Build absolute render URLs": { "main": [[{ "node": "Is long variant?", "type": "main", "index": 0 }]] },
    "Is long variant?": {
      "main": [
        [{ "node": "Call render-service /thumbnail", "type": "main", "index": 0 }],
        [{ "node": "Save render results (short)", "type": "main", "index": 0 }]
      ]
    },
    "Call render-service /thumbnail": { "main": [[{ "node": "Build absolute thumbnail URL", "type": "main", "index": 0 }]] },
    "Build absolute thumbnail URL": { "main": [[{ "node": "Save render results (long, with thumbnail)", "type": "main", "index": 0 }]] }
  },
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

- [ ] **Step 2: Aplicar ao vivo**

```bash
curl -s "$N8N_BASE/api/v1/workflows/7q2u4ySCyutTPGpC" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/render-live.json
```

Substituir `nodes`/`connections`, manter `credentials`/`settings` reais, `PUT` de volta.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/7q2u4ySCyutTPGpC" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/render-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `{"run_id": 1, "niche_id": 1, "variant": "long"}` primeiro (requer `voice_long_url`/`captions_long_json`/`assets_long_json`/`music_long_url` já preenchidos pelas Tasks 4-6).

Expected: `render_16x9_url` e `thumbnail_url` preenchidos, thumbnail com o texto do `topic` bem ajustado (sem corte) — conferir visualmente a imagem gerada. Depois testar com `"variant": "short"` (requer os campos `_short` preenchidos).

Expected: `render_9x16_url` preenchido, `thumbnail_url` **não** sobrescrito (mesma URL de antes).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/render.json
git commit -m "feat(n8n): version Render sub-workflow, parametrize by variant, thumbnail only on long"
```

---

## Task 8: Main Pipeline (encadear 2x — variant=long, variant=short)

**Files:**
- Modify: `n8n-workflows/main-pipeline.json`

- [ ] **Step 1: Reescrever `n8n-workflows/main-pipeline.json`**

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
      "credentials": { "postgres": { "id": "UwnVbemNZVcThSbB", "name": "Postgres postador" } }
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO postador.video_runs (niche_id, status, current_step) VALUES ($1, 'em_progresso', 'iniciado') RETURNING id AS run_id, niche_id;",
        "additionalFields": { "queryParams": "niche_id" }
      },
      "id": "pg-create-run",
      "name": "Create video_run",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [680, 300],
      "credentials": { "postgres": { "id": "UwnVbemNZVcThSbB", "name": "Postgres postador" } }
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
      "parameters": { "source": "database", "workflowId": "WdwmATwH8cDbRVZO" },
      "id": "exec-roteiro",
      "name": "Call Roteiro",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [1120, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'long' } }];" },
      "id": "code-input-voz-long",
      "name": "Build input for Voz (long)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1340, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "21MzrpQTSRFwh6Xa" },
      "id": "exec-voz-long",
      "name": "Call Voz (long)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [1560, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'long' } }];" },
      "id": "code-input-legenda-long",
      "name": "Build input for Legenda (long)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1780, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "K2582L7TX9s8wLci" },
      "id": "exec-legenda-long",
      "name": "Call Legenda (long)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2000, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'long' } }];" },
      "id": "code-input-assets-long",
      "name": "Build input for Assets (long)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2220, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "hvC6AtEMoD7B3BuX" },
      "id": "exec-assets-long",
      "name": "Call Assets (long)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2440, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'long' } }];" },
      "id": "code-input-render-long",
      "name": "Build input for Render (long)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [2660, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "7q2u4ySCyutTPGpC" },
      "id": "exec-render-long",
      "name": "Call Render (long)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [2880, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'short' } }];" },
      "id": "code-input-voz-short",
      "name": "Build input for Voz (short)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3100, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "21MzrpQTSRFwh6Xa" },
      "id": "exec-voz-short",
      "name": "Call Voz (short)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [3320, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'short' } }];" },
      "id": "code-input-legenda-short",
      "name": "Build input for Legenda (short)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3540, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "K2582L7TX9s8wLci" },
      "id": "exec-legenda-short",
      "name": "Call Legenda (short)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [3760, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'short' } }];" },
      "id": "code-input-assets-short",
      "name": "Build input for Assets (short)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3980, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "hvC6AtEMoD7B3BuX" },
      "id": "exec-assets-short",
      "name": "Call Assets (short)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [4200, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id, variant: 'short' } }];" },
      "id": "code-input-render-short",
      "name": "Build input for Render (short)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [4420, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "7q2u4ySCyutTPGpC" },
      "id": "exec-render-short",
      "name": "Call Render (short)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [4640, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-aprovacao",
      "name": "Build input for Aprovação",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [4860, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "UtqBinFZ1gQ3IyVz" },
      "id": "exec-aprovacao",
      "name": "Call Aprovação",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [5080, 300]
    },
    {
      "parameters": { "mode": "runOnceForAllItems", "jsCode": "return [{ json: { run_id: $node[\"Create video_run\"].json.run_id, niche_id: $node[\"Create video_run\"].json.niche_id } }];" },
      "id": "code-input-publish",
      "name": "Build input for Publish",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [5300, 300]
    },
    {
      "parameters": { "source": "database", "workflowId": "WzykicrsWM9N0Wqi" },
      "id": "exec-publish",
      "name": "Call Publish",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1,
      "position": [5520, 300]
    }
  ],
  "connections": {
    "Daily Schedule": { "main": [[{ "node": "Read active niches", "type": "main", "index": 0 }]] },
    "Read active niches": { "main": [[{ "node": "Create video_run", "type": "main", "index": 0 }]] },
    "Create video_run": { "main": [[{ "node": "Build input for Roteiro", "type": "main", "index": 0 }]] },
    "Build input for Roteiro": { "main": [[{ "node": "Call Roteiro", "type": "main", "index": 0 }]] },
    "Call Roteiro": { "main": [[{ "node": "Build input for Voz (long)", "type": "main", "index": 0 }]] },
    "Build input for Voz (long)": { "main": [[{ "node": "Call Voz (long)", "type": "main", "index": 0 }]] },
    "Call Voz (long)": { "main": [[{ "node": "Build input for Legenda (long)", "type": "main", "index": 0 }]] },
    "Build input for Legenda (long)": { "main": [[{ "node": "Call Legenda (long)", "type": "main", "index": 0 }]] },
    "Call Legenda (long)": { "main": [[{ "node": "Build input for Assets (long)", "type": "main", "index": 0 }]] },
    "Build input for Assets (long)": { "main": [[{ "node": "Call Assets (long)", "type": "main", "index": 0 }]] },
    "Call Assets (long)": { "main": [[{ "node": "Build input for Render (long)", "type": "main", "index": 0 }]] },
    "Build input for Render (long)": { "main": [[{ "node": "Call Render (long)", "type": "main", "index": 0 }]] },
    "Call Render (long)": { "main": [[{ "node": "Build input for Voz (short)", "type": "main", "index": 0 }]] },
    "Build input for Voz (short)": { "main": [[{ "node": "Call Voz (short)", "type": "main", "index": 0 }]] },
    "Call Voz (short)": { "main": [[{ "node": "Build input for Legenda (short)", "type": "main", "index": 0 }]] },
    "Build input for Legenda (short)": { "main": [[{ "node": "Call Legenda (short)", "type": "main", "index": 0 }]] },
    "Call Legenda (short)": { "main": [[{ "node": "Build input for Assets (short)", "type": "main", "index": 0 }]] },
    "Build input for Assets (short)": { "main": [[{ "node": "Call Assets (short)", "type": "main", "index": 0 }]] },
    "Call Assets (short)": { "main": [[{ "node": "Build input for Render (short)", "type": "main", "index": 0 }]] },
    "Build input for Render (short)": { "main": [[{ "node": "Call Render (short)", "type": "main", "index": 0 }]] },
    "Call Render (short)": { "main": [[{ "node": "Build input for Aprovação", "type": "main", "index": 0 }]] },
    "Build input for Aprovação": { "main": [[{ "node": "Call Aprovação", "type": "main", "index": 0 }]] },
    "Call Aprovação": { "main": [[{ "node": "Build input for Publish", "type": "main", "index": 0 }]] },
    "Build input for Publish": { "main": [[{ "node": "Call Publish", "type": "main", "index": 0 }]] }
  },
  "settings": { "errorWorkflow": "jwPN2t0n4jo5nXet", "availableInMCP": true }
}
```

- [ ] **Step 2: Aplicar ao vivo**

Main Pipeline (`EdP9q66OY0fgRaCG`) foi registrado via API (não UI) — visível ao MCP. Confirmar via `mcp__n8n__get_workflow_details` antes, depois `PUT`:

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/EdP9q66OY0fgRaCG" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/main-pipeline.json
```

Expected: `200`. `main-pipeline.json` já tem os `credentials` reais (`UwnVbemNZVcThSbB`) inline, não precisa de GET prévio pra preservar nada além disso.

- [ ] **Step 3: Commit**

```bash
git add n8n-workflows/main-pipeline.json
git commit -m "feat(n8n): chain Voz/Legenda/Assets/Render twice in Main Pipeline (variant=long, then variant=short)"
```

---

## Task 9: Sub-workflow Aprovação (2 links + trecho do script_long_text)

**Files:**
- Modify: `n8n-workflows/aprovacao.json`

- [ ] **Step 1: Reescrever `n8n-workflows/aprovacao.json`**

Só o node `Read run and niche for approval` e o `Send approval request` mudam (query lê `script_long_text`/`render_9x16_url`; mensagem inclui os 2 links):

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
        "query": "SELECT vr.id AS run_id, vr.topic, vr.script_long_text, vr.thumbnail_url, vr.render_16x9_url, vr.render_9x16_url, n.approval_mode FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
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
        "message": "=Tema: {{$node[\"Read run and niche for approval\"].json.topic}}\n\nTrecho do roteiro (long):\n{{$node[\"Read run and niche for approval\"].json.script_long_text.slice(0,300)}}...\n\nVídeo (16:9): {{$node[\"Read run and niche for approval\"].json.render_16x9_url}}\nVídeo (Shorts 9:16): {{$node[\"Read run and niche for approval\"].json.render_9x16_url}}",
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
      "alwaysOutputData": true,
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
      "alwaysOutputData": true,
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
  "settings": { "availableInMCP": true, "errorWorkflow": "jwPN2t0n4jo5nXet" }
}
```

- [ ] **Step 2: Aplicar ao vivo**

Aprovação foi importada via UI (`UtqBinFZ1gQ3IyVz`), **invisível ao MCP** — usar `curl` (GET prévio pra preservar `credentials` reais, inclusive Telegram):

```bash
curl -s "$N8N_BASE/api/v1/workflows/UtqBinFZ1gQ3IyVz" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/aprovacao-live.json
```

Substituir `nodes`/`connections`, manter `credentials`/`settings` reais, `PUT` de volta.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/UtqBinFZ1gQ3IyVz" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/aprovacao-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `{"run_id": 1, "niche_id": 1}` (requer `script_long_text`, `render_16x9_url`, `render_9x16_url`, `thumbnail_url` já preenchidos pelas tasks anteriores).

Expected: mensagem no Telegram mostra os 2 links de vídeo e o trecho de `script_long_text`.

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/aprovacao.json
git commit -m "feat(n8n): include both render URLs and script_long_text excerpt in approval message"
```

---

## Task 10: Sub-workflow Publish (descrição por variant: `script_long_text` / `script_short_text`)

**Files:**
- Modify: `n8n-workflows/publish.json`

- [ ] **Step 1: Atualizar `n8n-workflows/publish.json`**

Só o node `Read run and niche for publish` (adicionar `script_short_text`) e as 2 descrições de upload mudam. Ler o arquivo atual e aplicar:

```json
{
  "parameters": {
    "operation": "executeQuery",
    "query": "SELECT vr.id AS run_id, vr.status, vr.render_16x9_url, vr.render_9x16_url, vr.topic, vr.script_long_text, vr.script_short_text, n.youtube_made_for_kids, n.dry_run FROM postador.video_runs vr JOIN postador.niches n ON n.id = vr.niche_id WHERE vr.id = $1;",
    "additionalFields": { "queryParams": "run_id" }
  },
  "id": "pg-read-run",
  "name": "Read run and niche for publish",
  "type": "n8n-nodes-base.postgres",
  "typeVersion": 1,
  "position": [460, 300],
  "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
}
```

Node `Upload 16:9 to YouTube` — `options.description` passa a usar `script_long_text`:

```json
"description": "={{$node[\"Read run and niche for publish\"].json.script_long_text}}\n\nMusic by Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/"
```

Node `Upload 9:16 to YouTube` — `options.description` passa a usar `script_short_text`:

```json
"description": "={{$node[\"Read run and niche for publish\"].json.script_short_text}}\n\nMusic by Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/"
```

Resto do arquivo (`Is approved?`, `Is dry run?`, downloads, extrações de id, `Save publish results`) sem mudança.

- [ ] **Step 2: Aplicar ao vivo**

Publish foi importado via UI (`WzykicrsWM9N0Wqi`), **invisível ao MCP** — usar `curl` (GET prévio, essencial aqui pra preservar a credencial YouTube OAuth2, cujo id não está anotado em lugar nenhum):

```bash
curl -s "$N8N_BASE/api/v1/workflows/WzykicrsWM9N0Wqi" -H "X-N8N-API-KEY: $N8N_API_KEY" > /tmp/publish-live.json
```

Editar só os 3 trechos acima dentro de `/tmp/publish-live.json` (query do `pg-read-run` + as 2 `description`), manter todo o resto (`credentials`, `settings`) intocado.

```bash
curl -s -X PUT "$N8N_BASE/api/v1/workflows/WzykicrsWM9N0Wqi" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/publish-live.json
```

- [ ] **Step 3: Testar isolado**

Testar na UI com `dry_run=true` no nicho de teste (já é o padrão) e `{"run_id": 1, "niche_id": 1}`.

Expected: `current_step` vira `dry_run_stop`, nenhum upload real acontece (mesmo comportamento de sempre — só a fonte da descrição mudou, não testável sem publicar de verdade).

- [ ] **Step 4: Commit**

```bash
git add n8n-workflows/publish.json
git commit -m "feat(n8n): use script_long_text/script_short_text per upload format in Publish descriptions"
```

---

## Task 11: Verificação ponta-a-ponta + cleanup das colunas antigas

**Files:**
- Modify: `sql/schema.sql`
- Create: `n8n-workflows/migracao-video-runs-variant-cleanup.json`

- [ ] **Step 1: Rodar o Main Pipeline completo com `dry_run=true`**

Confirmar `niche_id=1.dry_run = true` (deve já estar assim). Disparar manualmente o Main Pipeline (`EdP9q66OY0fgRaCG`) via UI ou `mcp__n8n__execute_workflow` (é Schedule Trigger, elegível a MCP).

Expected: cadeia completa Roteiro → Voz(long) → Legenda(long) → Assets(long) → Render(long) → Voz(short) → Legenda(short) → Assets(short) → Render(short) → Aprovação (toque manual no Telegram) → Publish. `status` final `'aprovado'`, `current_step` final `'dry_run_stop'`. Conferir no Postgres:

```sql
SELECT topic, script_long_text IS NOT NULL AS has_long, script_short_text IS NOT NULL AS has_short,
       voice_long_url, voice_short_url, render_16x9_url, render_9x16_url, thumbnail_url, clip_keywords
FROM postador.video_runs ORDER BY id DESC LIMIT 1;
```

Conferir visualmente: baixar `render_16x9_url` (deve ter ~2-3min) e `render_9x16_url` (deve ter ~60-75s), e `thumbnail_url` (título sem corte, quebrado em 1-2 linhas legíveis).

- [ ] **Step 2: Se tudo passar, confirmar com o usuário antes do cleanup destrutivo**

Perguntar ao usuário se pode rodar o `DROP COLUMN` das colunas antigas (`script_text`, `voice_url`, `captions_json`, `assets_json`, `music_url`) — isso é **irreversível** e descarta o histórico dessas colunas nas linhas antigas de `video_runs` (só linhas de teste, mas ainda assim uma ação destrutiva que merece confirmação explícita).

- [ ] **Step 3: Criar `n8n-workflows/migracao-video-runs-variant-cleanup.json`**

```json
{
  "name": "Postador - Cleanup colunas antigas video_runs (descartável)",
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
        "query": "ALTER TABLE postador.video_runs\n  DROP COLUMN IF EXISTS script_text,\n  DROP COLUMN IF EXISTS voice_url,\n  DROP COLUMN IF EXISTS captions_json,\n  DROP COLUMN IF EXISTS assets_json,\n  DROP COLUMN IF EXISTS music_url;"
      },
      "id": "pg-ddl",
      "name": "Run DDL",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 1,
      "position": [460, 300],
      "alwaysOutputData": true,
      "credentials": { "postgres": { "id": "__PG_CRED_ID__", "name": "Postgres postador" } }
    }
  ],
  "connections": {
    "Schedule Trigger": { "main": [[{ "node": "Run DDL", "type": "main", "index": 0 }]] }
  },
  "settings": {}
}
```

- [ ] **Step 4: Registrar e rodar (só após confirmação do Step 2)**

```bash
(Get-Content n8n-workflows/migracao-video-runs-variant-cleanup.json -Raw) -replace '__PG_CRED_ID__', $PG_CRED_ID | Set-Content n8n-workflows/migracao-video-runs-variant-cleanup.json.tmp
curl -s -X POST "$N8N_BASE/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @n8n-workflows/migracao-video-runs-variant-cleanup.json.tmp
```

Rodar via `mcp__n8n__execute_workflow` com o id retornado. Depois desativar o workflow.

- [ ] **Step 5: Remover as colunas antigas de `sql/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS postador.video_runs (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  status TEXT NOT NULL DEFAULT 'em_progresso',
  current_step TEXT,
  topic TEXT,
  script_long_text TEXT,
  script_short_text TEXT,
  voice_long_url TEXT,
  voice_short_url TEXT,
  captions_long_json JSONB,
  captions_short_json JSONB,
  assets_long_json JSONB,
  assets_short_json JSONB,
  music_long_url TEXT,
  music_short_url TEXT,
  clip_keywords TEXT[],
  render_16x9_url TEXT,
  render_9x16_url TEXT,
  thumbnail_url TEXT,
  youtube_video_id TEXT,
  youtube_shorts_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 6: Commit**

```bash
git add sql/schema.sql n8n-workflows/migracao-video-runs-variant-cleanup.json
git commit -m "chore(db): drop legacy single-script video_runs columns after variant migration verified"
```

- [ ] **Step 7: Atualizar `CLAUDE.md`**

Adicionar uma entrada em "Status atual" registrando: separação long/short implementada e verificada ponta-a-ponta (dry_run), thumbnail com wrap/fontsize dinâmico corrigido, `clip_keywords` por episódio substituindo as 4 keywords estáticas do nicho.

```bash
git add CLAUDE.md
git commit -m "docs: record long/short variant pipeline + thumbnail fix in Publish workflow history"
```
