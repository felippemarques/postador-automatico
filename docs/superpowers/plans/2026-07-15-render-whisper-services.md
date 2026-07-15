# Serviços de Render (FFmpeg) e Legenda (Whisper) — Plano de Implementação

> **Para quem for executar:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra rodar esse plano tarefa por tarefa. Passos usam checkbox (`- [x]`) pra rastreamento.

**Goal:** Construir e publicar na VPS (Coolify) os dois microserviços de infraestrutura que o pipeline n8n vai chamar via HTTP: `render-service` (compõe o vídeo final via FFmpeg, 2 formatos) e `whisper-service` (gera legenda com timestamp palavra-a-palavra via faster-whisper). Esses dois serviços são a base técnica antes de construir os workflows n8n (plano seguinte).

**Architecture:** Dois apps Node.js/Python independentes, cada um um repositório-diretório dentro do monorepo `postador-automatico`, cada um com seu próprio Dockerfile, testados via TDD (Node built-in test runner / pytest) com dependency injection pra evitar dependência de FFmpeg/modelo Whisper real durante os testes. Deploy via Coolify API (`applications/public`, build_pack `dockerfile`), cada app aponta pro mesmo repo GitHub com `base_directory` diferente. Cada serviço expõe endpoint HTTP protegido por Bearer token fixo (env var), alcançável publicamente pelo n8n via domínio automático `*.sslip.io` que o Coolify já gera.

**Tech Stack:** Node.js 22 (Express, `node:test` builtin) pro render-service; Python 3.11 (FastAPI, faster-whisper, pytest) pro whisper-service; Docker (arm64, roda na VPS Oracle A1.Flex); Coolify API pra deploy; GitHub (repo público) como origem do build.

---

## Contexto verificado nesta sessão (não re-verificar, já confirmado ao vivo)

- Coolify em `http://137.131.180.11:8000`, token com permissão `deploy` confirmada ao vivo (`GET /api/v1/deploy?uuid=...` retorna 200 com `deployment_uuid`). **Token não fica documentado aqui** (rotacionado após vazamento acidental em commit anterior — ver histórico do repo) — obter valor atual com o operador antes de rodar os comandos da Tarefa 9.
- `project_uuid`: `l12q80mwj4jfbxs6tr3scdk1` (projeto "Staging")
- `server_uuid`: `dgigt2wk487p1qhqt3fdziz1` (server "localhost", é a própria VPS)
- `environment_uuid`: `a1ozrnus27wf28snh4hduyji` (environment "production")
- Endpoint de criação testado ao vivo: `POST /api/v1/applications/public` — campos obrigatórios `project_uuid`, `server_uuid`, `environment_uuid`, `git_repository`, `git_branch`, `build_pack`. Campos opcionais confirmados: `name`, `base_directory`, `ports_exposes`, `instant_deploy`. Resposta: `{"uuid": "...", "domains": "http://<uuid>.137.131.180.11.sslip.io"}`.
- Endpoint de env vars testado ao vivo: `PATCH /api/v1/applications/{uuid}/envs/bulk` body `{"data":[{"key":"K","value":"V"}]}` → 201.
- `gh` CLI já autenticado localmente como `felippemarques`, `git`, `node v24`, `python 3.13` disponíveis na máquina local.
- Tokens de auth dos serviços: **não documentar valores reais aqui** — gerar/rotacionar e guardar apenas em local seguro (gestor de segredos, env do Coolify), nunca em arquivo versionado.

---

### Task 1: Repositório Git + GitHub

**Files:**
- Create: `.gitignore`

- [x] **Step 1: Criar `.gitignore`**

```
node_modules/
__pycache__/
*.pyc
.venv/
dist/
*.log
```

- [x] **Step 2: Inicializar repo e criar remoto GitHub**

Run:
```bash
cd "C:/home/pessoal/postador-automatico"
git init
git add .gitignore docs
git commit -m "chore: init repo with design docs"
gh repo create postador-automatico --public --source=. --remote=origin --push
```

Expected: repo criado em `https://github.com/felippemarques/postador-automatico`, branch `main` enviada.

---

### Task 2: render-service — health endpoint (TDD)

**Files:**
- Create: `render-service/package.json`
- Create: `render-service/src/server.js`
- Test: `render-service/src/__tests__/server.test.js`

- [x] **Step 1: Criar `package.json`**

```json
{
  "name": "render-service",
  "version": "1.0.0",
  "private": true,
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test src"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

Run: `cd render-service && npm install`

- [x] **Step 2: Escrever teste que falha**

```js
// render-service/src/__tests__/server.test.js
process.env.RENDER_AUTH_TOKEN = 'secret';
process.env.RENDERS_DIR = require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

function listen(appInstance) {
  return new Promise((resolve) => {
    const server = appInstance.listen(0, () => resolve(server));
  });
}

test('GET /health returns ok', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { status: 'ok' });
  server.close();
});
```

- [x] **Step 3: Rodar teste, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `Cannot find module '../server'`

- [x] **Step 4: Implementar `server.js` mínimo**

```js
// render-service/src/server.js
const express = require('express');

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function start() {
  app.listen(PORT, () => {
    console.log(`render-service listening on ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
```

- [x] **Step 5: Rodar teste, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS (1 teste)

- [x] **Step 6: Commit**

```bash
git add render-service/package.json render-service/src/server.js render-service/src/__tests__/server.test.js
git commit -m "feat(render-service): add health endpoint"
```

---

### Task 3: render-service — composição FFmpeg (compose.js)

**Files:**
- Create: `render-service/src/compose.js`
- Test: `render-service/src/__tests__/compose.test.js`

- [x] **Step 1: Escrever testes que falham**

```js
// render-service/src/__tests__/compose.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFfmpegArgs, srtTimestamp, buildSrt } = require('../compose');

test('srtTimestamp formats seconds as SRT timestamp', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000');
  assert.equal(srtTimestamp(65.25), '00:01:05,250');
});

test('buildSrt renders numbered cue blocks', () => {
  const srt = buildSrt([{ start: 0, end: 1.5, text: 'Ola' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nOla\n');
});

test('buildFfmpegArgs builds filter_complex for 16:9 with 2 clips', () => {
  const job = {
    clips: [{ path: 'a.mp4' }, { path: 'b.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
    musicVolume: 0.3,
  };
  const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
  assert.deepEqual(args.slice(0, 6), ['-i', 'a.mp4', '-i', 'b.mp4', '-i', 'voice.mp3']);
  const filterIndex = args.indexOf('-filter_complex');
  assert.ok(filterIndex !== -1);
  const filter = args[filterIndex + 1];
  assert.match(filter, /scale=1920:1080/);
  assert.match(filter, /concat=n=2:v=1:a=0\[vcat\]/);
  assert.match(filter, /volume=0\.3\[music\]/);
  assert.equal(args.at(-1), 'out.mp4');
});

test('buildFfmpegArgs builds 9:16 with correct dimensions', () => {
  const job = { clips: [{ path: 'a.mp4' }], voicePath: 'v.mp3', musicPath: 'm.mp3' };
  const args = buildFfmpegArgs(job, '9:16', 'out.srt', 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=1080:1920/);
});

test('buildFfmpegArgs throws on unknown format', () => {
  assert.throws(() => buildFfmpegArgs({ clips: [] }, '1:1', 'a.srt', 'a.mp4'), /unknown format/);
});
```

- [x] **Step 2: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `Cannot find module '../compose'`

- [x] **Step 3: Implementar `compose.js`**

```js
// render-service/src/compose.js
const fs = require('node:fs');

const FORMATS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function srtTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

function buildSrt(captions) {
  return captions
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

function writeSrt(captions, filePath) {
  fs.writeFileSync(filePath, buildSrt(captions), 'utf8');
  return filePath;
}

function buildFfmpegArgs(job, formatKey, srtPath, outPath) {
  const format = FORMATS[formatKey];
  if (!format) throw new Error(`unknown format: ${formatKey}`);
  const { width, height } = format;
  const clipCount = job.clips.length;
  const voiceIndex = clipCount;
  const musicIndex = clipCount + 1;

  const inputs = [];
  job.clips.forEach((clip) => inputs.push('-i', clip.path));
  inputs.push('-i', job.voicePath);
  inputs.push('-i', job.musicPath);

  const scaleLabels = job.clips
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${i}]`)
    .join(';');
  const concatInputs = job.clips.map((_, i) => `[v${i}]`).join('');
  const concat = `${concatInputs}concat=n=${clipCount}:v=1:a=0[vcat]`;
  const subtitles = `[vcat]subtitles=${srtPath.replace(/:/g, '\\:')}[vout]`;
  const musicVolume = job.musicVolume ?? 0.25;
  const audioMix = `[${voiceIndex}:a]volume=1.0[voice];[${musicIndex}:a]volume=${musicVolume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

  const filterComplex = [scaleLabels, concat, subtitles, audioMix].join(';');

  return [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-y',
    outPath,
  ];
}

module.exports = { buildFfmpegArgs, buildSrt, writeSrt, srtTimestamp, FORMATS };
```

- [x] **Step 4: Rodar, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS (6 testes no total)

- [x] **Step 5: Commit**

```bash
git add render-service/src/compose.js render-service/src/__tests__/compose.test.js
git commit -m "feat(render-service): add ffmpeg filter_complex builder and srt writer"
```

---

### Task 4: render-service — orquestração do render (render.js)

**Files:**
- Create: `render-service/src/render.js`
- Test: `render-service/src/__tests__/render.test.js`

- [x] **Step 1: Escrever testes que falham**

```js
// render-service/src/__tests__/render.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderJob, runFfmpeg } = require('../render');

test('renderJob writes srt and calls ffmpeg twice (16:9 and 9:16)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push(args);
    cb(null, '', '');
  };
  const job = {
    jobId: 'job1',
    clips: [{ path: 'a.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
    captions: [{ start: 0, end: 1, text: 'oi' }],
  };
  const files = await renderJob(job, outDir, fakeExecFile);
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(path.join(outDir, 'job1.srt')));
  assert.equal(files['16:9'], path.join(outDir, 'job1-16x9.mp4'));
  assert.equal(files['9:16'], path.join(outDir, 'job1-9x16.mp4'));
});

test('runFfmpeg rejects with stderr message on failure', async () => {
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error('boom'), '', 'ffmpeg error output');
  await assert.rejects(() => runFfmpeg(['-i', 'x'], fakeExecFile), /ffmpeg error output/);
});
```

- [x] **Step 2: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — `Cannot find module '../render'`

- [x] **Step 3: Implementar `render.js`**

```js
// render-service/src/render.js
const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildFfmpegArgs, writeSrt } = require('./compose');

function runFfmpeg(args, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffmpeg failed: ${stderr || error.message}`));
      resolve({ stdout, stderr });
    });
  });
}

async function renderJob(job, outDir, execFileImpl = execFile) {
  const srtPath = path.join(outDir, `${job.jobId}.srt`);
  writeSrt(job.captions, srtPath);
  const results = {};
  for (const formatKey of ['16:9', '9:16']) {
    const outPath = path.join(outDir, `${job.jobId}-${formatKey.replace(':', 'x')}.mp4`);
    const args = buildFfmpegArgs(job, formatKey, srtPath, outPath);
    await runFfmpeg(args, execFileImpl);
    results[formatKey] = outPath;
  }
  return results;
}

module.exports = { runFfmpeg, renderJob };
```

- [x] **Step 4: Rodar, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS (8 testes no total)

- [x] **Step 5: Commit**

```bash
git add render-service/src/render.js render-service/src/__tests__/render.test.js
git commit -m "feat(render-service): orchestrate srt + dual-format ffmpeg render"
```

---

### Task 5: render-service — endpoint `/render`, auth, Dockerfile

**Files:**
- Modify: `render-service/src/server.js`
- Test: `render-service/src/__tests__/server.test.js`
- Create: `render-service/Dockerfile`
- Create: `render-service/.dockerignore`

- [x] **Step 1: Adicionar testes que falham em `server.test.js`**

```js
// adicionar ao final de render-service/src/__tests__/server.test.js

test('POST /render without auth returns 401', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  server.close();
});

test('POST /render with auth but missing fields returns 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  server.close();
});
```

- [x] **Step 2: Rodar, confirmar falha**

Run: `cd render-service && npm test`
Expected: FAIL — recebe 404/undefined em vez de 401/400 (rota `/render` ainda não existe)

- [x] **Step 3: Implementar rota `/render` completa em `server.js`**

```js
// render-service/src/server.js — substituir o arquivo inteiro
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderJob } = require('./render');

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN;
const RENDERS_DIR = process.env.RENDERS_DIR || '/data/renders';

const app = express();
app.use(express.json({ limit: '2mb' }));

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN || req.get('authorization') !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function downloadToTmp(url, destDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const destPath = path.join(destDir, `${crypto.randomUUID()}-${path.basename(new URL(url).pathname)}`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

app.post('/render', requireAuth, async (req, res) => {
  const { jobId, clips, voiceUrl, musicUrl, captions, musicVolume } = req.body || {};
  if (!jobId || !Array.isArray(clips) || clips.length === 0 || !voiceUrl || !musicUrl || !Array.isArray(captions)) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  const jobDir = path.join(RENDERS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const localClips = [];
    for (const clip of clips) {
      localClips.push({ path: await downloadToTmp(clip.url, jobDir) });
    }
    const voicePath = await downloadToTmp(voiceUrl, jobDir);
    const musicPath = await downloadToTmp(musicUrl, jobDir);
    const files = await renderJob(
      { jobId, clips: localClips, voicePath, musicPath, captions, musicVolume },
      jobDir
    );
    const fileUrls = Object.fromEntries(
      Object.entries(files).map(([format, filePath]) => [format, `/files/${jobId}/${path.basename(filePath)}`])
    );
    res.json({ jobId, files: fileUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/files', express.static(RENDERS_DIR));

function start() {
  app.listen(PORT, () => {
    console.log(`render-service listening on ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
```

- [x] **Step 4: Rodar, confirmar sucesso**

Run: `cd render-service && npm test`
Expected: PASS (10 testes no total)

- [x] **Step 5: Criar `Dockerfile`**

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=8080
ENV RENDERS_DIR=/data/renders
EXPOSE 8080
CMD ["node", "src/server.js"]
```

- [x] **Step 6: Criar `.dockerignore`**

```
node_modules
src/__tests__
```

- [x] **Step 7: Commit**

```bash
git add render-service/src/server.js render-service/src/__tests__/server.test.js render-service/Dockerfile render-service/.dockerignore
git commit -m "feat(render-service): add /render endpoint with auth, download, and dockerfile"
```

---

### Task 6: whisper-service — health + auth (TDD)

**Files:**
- Create: `whisper-service/requirements.txt`
- Create: `whisper-service/requirements-dev.txt`
- Create: `whisper-service/src/__init__.py`
- Create: `whisper-service/src/server.py`
- Test: `whisper-service/tests/test_server.py`

- [x] **Step 1: Criar `requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
faster-whisper==1.0.3
```

- [x] **Step 2: Criar `requirements-dev.txt`**

```
-r requirements.txt
pytest==8.3.2
httpx==0.27.2
```

- [x] **Step 3: Criar venv e instalar deps**

Run:
```bash
cd whisper-service
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt
```

Se `faster-whisper==1.0.3` falhar por falta de wheel `ctranslate2` na sua plataforma local (Windows/ARM), use pra desenvolvimento local apenas um mock — a instalação real acontece dentro do Docker (linux/arm64) na Tarefa 8, que é o ambiente que importa. Prossiga os testes com o pacote `faster_whisper` mockado (Step 2 da Tarefa 7 já faz isso).

- [x] **Step 4: Criar `src/__init__.py` vazio**

- [x] **Step 5: Escrever teste que falha**

```python
# whisper-service/tests/test_server.py
import os
os.environ["WHISPER_AUTH_TOKEN"] = "secret"
os.environ["WHISPER_MODEL_SIZE"] = "base"

import sys
import types
from unittest.mock import MagicMock

fake_fw_module = types.ModuleType("faster_whisper")
fake_fw_module.WhisperModel = MagicMock(return_value=MagicMock())
sys.modules["faster_whisper"] = fake_fw_module

from fastapi.testclient import TestClient
from src.server import app

client = TestClient(app)


def test_health_ok():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "model": "base"}


def test_transcribe_requires_auth():
    res = client.post("/transcribe", json={"audioUrl": "http://x/audio.mp3"})
    assert res.status_code == 401
```

- [x] **Step 6: Rodar, confirmar falha**

Run: `cd whisper-service && .venv/Scripts/pytest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.server'`

- [x] **Step 7: Implementar `server.py`**

```python
# whisper-service/src/server.py
import os
import tempfile
import urllib.request

from fastapi import FastAPI, Header, HTTPException
from faster_whisper import WhisperModel

from src.transcribe import transcribe_audio

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")
AUTH_TOKEN = os.environ["WHISPER_AUTH_TOKEN"]

app = FastAPI()
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")


def urlretrieve_audio(url, dest_path):
    urllib.request.urlretrieve(url, dest_path)


def check_auth(authorization):
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE}


@app.post("/transcribe")
def transcribe(payload: dict, authorization: str = Header(None)):
    check_auth(authorization)
    audio_url = payload["audioUrl"]
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        urlretrieve_audio(audio_url, tmp_path)
        return transcribe_audio(tmp_path, model)
    finally:
        os.unlink(tmp_path)
```

Nota: esse arquivo importa `src.transcribe`, que ainda não existe — a Tarefa 7 cria. Pra rodar só os testes dessa tarefa agora, crie temporariamente um `whisper-service/src/transcribe.py` com:

```python
def transcribe_audio(path, model):
    raise NotImplementedError
```

- [x] **Step 8: Rodar, confirmar sucesso**

Run: `cd whisper-service && .venv/Scripts/pytest -v`
Expected: PASS (2 testes)

- [x] **Step 9: Commit**

```bash
git add whisper-service/requirements.txt whisper-service/requirements-dev.txt whisper-service/src/__init__.py whisper-service/src/server.py whisper-service/src/transcribe.py whisper-service/tests/test_server.py
git commit -m "feat(whisper-service): add health endpoint and bearer auth"
```

---

### Task 7: whisper-service — transcrição (transcribe.py)

**Files:**
- Modify: `whisper-service/src/transcribe.py`
- Test: `whisper-service/tests/test_transcribe.py`

- [x] **Step 1: Escrever teste que falha**

```python
# whisper-service/tests/test_transcribe.py
from types import SimpleNamespace
from src.transcribe import transcribe_audio


class FakeWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class FakeSegment:
    def __init__(self, text, start, end, words):
        self.text = text
        self.start = start
        self.end = end
        self.words = words


class FakeModel:
    def transcribe(self, path, word_timestamps=True):
        segments = [
            FakeSegment(" Ola mundo", 0.0, 1.2, [FakeWord("Ola", 0.0, 0.5), FakeWord("mundo", 0.5, 1.2)]),
        ]
        return segments, SimpleNamespace(language="pt")


def test_transcribe_audio_returns_text_segments_and_words():
    result = transcribe_audio("fake.mp3", FakeModel())
    assert result["text"] == "Ola mundo"
    assert result["segments"] == [{"text": "Ola mundo", "start": 0.0, "end": 1.2}]
    assert result["words"] == [
        {"word": "Ola", "start": 0.0, "end": 0.5},
        {"word": "mundo", "start": 0.5, "end": 1.2},
    ]
```

- [x] **Step 2: Rodar, confirmar falha**

Run: `cd whisper-service && .venv/Scripts/pytest tests/test_transcribe.py -v`
Expected: FAIL — `NotImplementedError`

- [x] **Step 3: Implementar `transcribe.py`**

```python
# whisper-service/src/transcribe.py
def transcribe_audio(path, model):
    segments, _info = model.transcribe(path, word_timestamps=True)
    seg_list = []
    words = []
    for seg in segments:
        seg_list.append({"text": seg.text.strip(), "start": seg.start, "end": seg.end})
        for w in (seg.words or []):
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    full_text = " ".join(s["text"] for s in seg_list)
    return {"text": full_text, "segments": seg_list, "words": words}
```

- [x] **Step 4: Rodar todos os testes, confirmar sucesso**

Run: `cd whisper-service && .venv/Scripts/pytest -v`
Expected: PASS (4 testes no total)

- [x] **Step 5: Commit**

```bash
git add whisper-service/src/transcribe.py whisper-service/tests/test_transcribe.py
git commit -m "feat(whisper-service): implement word-level transcription mapping"
```

---

### Task 8: whisper-service — conectar transcribe real ao endpoint, Dockerfile

**Files:**
- Modify: `whisper-service/tests/test_server.py`
- Create: `whisper-service/Dockerfile`
- Create: `whisper-service/.dockerignore`

- [x] **Step 1: Adicionar teste de sucesso do `/transcribe` com monkeypatch**

```python
# adicionar ao final de whisper-service/tests/test_server.py
import src.server as server_module


def test_transcribe_success(monkeypatch):
    monkeypatch.setattr(server_module, "transcribe_audio", lambda path, model: {"text": "oi", "segments": [], "words": []})
    monkeypatch.setattr(server_module, "urlretrieve_audio", lambda url, dest: None)
    res = client.post(
        "/transcribe",
        json={"audioUrl": "http://x/audio.mp3"},
        headers={"authorization": "Bearer secret"},
    )
    assert res.status_code == 200
    assert res.json() == {"text": "oi", "segments": [], "words": []}
```

- [x] **Step 2: Rodar, confirmar sucesso**

Run: `cd whisper-service && .venv/Scripts/pytest -v`
Expected: PASS (5 testes no total) — `server.py` já chama `transcribe_audio` e `urlretrieve_audio` como atributos do módulo, então o monkeypatch já funciona sem mudar `server.py`

- [x] **Step 3: Criar `Dockerfile`**

```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
ENV WHISPER_MODEL_SIZE=base
EXPOSE 8000
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
```

Se o build falhar com erro de `ctranslate2` (wheel arm64 indisponível pra versão pinada), trocar a linha do `faster-whisper` em `requirements.txt` pra uma versão mais recente (`faster-whisper>=1.1.0`) que já publica wheel `manylinux_aarch64` — reconstruir a imagem depois da troca.

- [x] **Step 4: Criar `.dockerignore`**

```
.venv
__pycache__
tests
```

- [x] **Step 5: Commit**

```bash
git add whisper-service/tests/test_server.py whisper-service/Dockerfile whisper-service/.dockerignore
git commit -m "feat(whisper-service): wire transcribe endpoint and add dockerfile"
```

---

### Task 9: Deploy dos dois serviços no Coolify

**Files:** nenhum arquivo de código — chamadas de API.

- [x] **Step 1: Push do estado atual pro GitHub**

Run:
```bash
git push origin main
```

- [x] **Step 2: Criar app `render-service` no Coolify**

Run:
```bash
TOKEN="<obter com o operador — não versionar>"
BASE="http://137.131.180.11:8000"
curl -s -X POST "$BASE/api/v1/applications/public" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{
    "project_uuid":"l12q80mwj4jfbxs6tr3scdk1",
    "server_uuid":"dgigt2wk487p1qhqt3fdziz1",
    "environment_uuid":"a1ozrnus27wf28snh4hduyji",
    "git_repository":"https://github.com/felippemarques/postador-automatico",
    "git_branch":"main",
    "build_pack":"dockerfile",
    "name":"render-service",
    "base_directory":"/render-service",
    "ports_exposes":"8080",
    "instant_deploy":false
  }'
```

Expected: `201`, resposta com `uuid` e `domains` (`http://<uuid>.137.131.180.11.sslip.io`). Anote o `uuid` retornado como `RENDER_APP_UUID`.

- [x] **Step 3: Configurar env vars do render-service**

Run (substituir `RENDER_APP_UUID` pelo uuid do Step 2):
```bash
curl -s -X PATCH "$BASE/api/v1/applications/RENDER_APP_UUID/envs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{"data":[{"key":"RENDER_AUTH_TOKEN","value":"<gerar novo valor — não versionar>"}]}'
```

Expected: `201`

- [x] **Step 4: Deploy do render-service**

Run:
```bash
curl -s "$BASE/api/v1/deploy?uuid=RENDER_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200`, JSON com `deployments[0].deployment_uuid`. Acompanhar build no dashboard Coolify se quiser ver logs ao vivo.

- [x] **Step 5: Repetir Steps 2-4 pro whisper-service**

Run:
```bash
curl -s -X POST "$BASE/api/v1/applications/public" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{
    "project_uuid":"l12q80mwj4jfbxs6tr3scdk1",
    "server_uuid":"dgigt2wk487p1qhqt3fdziz1",
    "environment_uuid":"a1ozrnus27wf28snh4hduyji",
    "git_repository":"https://github.com/felippemarques/postador-automatico",
    "git_branch":"main",
    "build_pack":"dockerfile",
    "name":"whisper-service",
    "base_directory":"/whisper-service",
    "ports_exposes":"8000",
    "instant_deploy":false
  }'
```

Anote o `uuid` retornado como `WHISPER_APP_UUID`, então:
```bash
curl -s -X PATCH "$BASE/api/v1/applications/WHISPER_APP_UUID/envs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{"data":[{"key":"WHISPER_AUTH_TOKEN","value":"<gerar novo valor — não versionar>"}]}'
curl -s "$BASE/api/v1/deploy?uuid=WHISPER_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200` no deploy, mesmo formato de resposta do Step 4.

- [x] **Step 6: Confirmar os dois apps rodando**

Run:
```bash
curl -s "$BASE/api/v1/applications/RENDER_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
curl -s "$BASE/api/v1/applications/WHISPER_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `"status":"running:healthy"` nos dois. Anote os dois `fqdn`/`domains` — são as URLs que o n8n vai chamar no próximo plano.

---

### Task 10: Smoke test end-to-end contra os serviços publicados

**Files:** nenhum arquivo de código.

- [x] **Step 1: Testar `/health` público dos dois serviços**

Run (trocar pelas URLs reais anotadas na Tarefa 9):
```bash
curl -s https://render-service-RENDER_APP_UUID.137.131.180.11.sslip.io/health
curl -s https://whisper-service-WHISPER_APP_UUID.137.131.180.11.sslip.io/health
```

Expected: `{"status":"ok"}` e `{"status":"ok","model":"base"}`

- [x] **Step 2: Testar `/render` com clipes/áudio de amostra públicos**

Run (usar 2 vídeos de amostra públicos + um mp3 de amostra público, ou arquivos hospedados em algum bucket seu):
```bash
curl -s -X POST https://render-service-RENDER_APP_UUID.137.131.180.11.sslip.io/render \
  -H "Authorization: Bearer <RENDER_AUTH_TOKEN atual>" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId":"smoke-test-1",
    "clips":[{"url":"https://sample-videos.com/video321/mp4/720/sample_960x400_ocean_with_audio.mp4"}],
    "voiceUrl":"https://file-examples.com/storage/fe0b3d3e6c66e0c8f01b4b6/2017/11/file_example_MP3_700KB.mp3",
    "musicUrl":"https://file-examples.com/storage/fe0b3d3e6c66e0c8f01b4b6/2017/11/file_example_MP3_700KB.mp3",
    "captions":[{"start":0,"end":2,"text":"Teste de legenda"}]
  }'
```

Expected: `200`, JSON com `files["16:9"]` e `files["9:16"]` apontando pra `/files/smoke-test-1/...`. Baixar um dos arquivos e abrir localmente pra conferir visualmente: 2 formatos gerados, legenda aparece, áudio de voz + música audíveis.

Nota: se as URLs de amostra acima estiverem fora do ar, substituir por qualquer par de vídeo curto + 2 áudios mp3 públicos — o objetivo do passo é validar o pipeline completo (download → ffmpeg → arquivo servido), não os arquivos em si.

- [x] **Step 3: Testar `/transcribe` com áudio de amostra**

Run:
```bash
curl -s -X POST https://whisper-service-WHISPER_APP_UUID.137.131.180.11.sslip.io/transcribe \
  -H "Authorization: Bearer <WHISPER_AUTH_TOKEN atual>" \
  -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://file-examples.com/storage/fe0b3d3e6c66e0c8f01b4b6/2017/11/file_example_MP3_700KB.mp3"}'
```

Expected: `200`, JSON com `text`, `segments`, `words` preenchidos com o conteúdo transcrito do áudio.

- [x] **Step 4: Documentar as URLs finais**

Adicionar ao final de `docs/superpowers/specs/2026-07-14-postador-automatico-design.md` uma seção "## Endpoints Publicados" com as duas URLs reais e confirmação de que ambos passaram no smoke test — isso vira input direto do próximo plano (workflows n8n).

---

## Próximo passo

Depois desse plano concluído: novo ciclo de brainstorming/plano pros workflows n8n em si (Roteiro, Voz, Legenda, Assets, Render, Aprovação, Publish), já consumindo as URLs reais do `render-service` e `whisper-service` publicados aqui.
