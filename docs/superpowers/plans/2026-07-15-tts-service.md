# tts-service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir e publicar na VPS (Coolify) um terceiro microserviço, `tts-service`, que expõe Edge-TTS (`pt-BR-AntonioNeural`) via HTTP — peça de infraestrutura que faltava para o sub-workflow "Voz" do plano `docs/superpowers/plans/2026-07-15-n8n-workflows-design.md` (Edge-TTS é uma lib Python que fala com o serviço da Microsoft por WebSocket, não tem API HTTP pública; n8n não consegue chamá-la diretamente).

**Architecture:** Mesmo padrão de `whisper-service` (FastAPI + Python + Coolify, mesma VPS/projeto/ambiente): endpoint `POST /synthesize` recebe `{text, voice}`, gera mp3 via `edge-tts`, salva em disco, serve em `/files/<jobId>.mp3` (mesmo padrão de arquivo estático já usado em `render-service`). Bearer auth via `TTS_AUTH_TOKEN`.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, `edge-tts` (PyPI), pytest.

---

## Contexto (herdado dos planos anteriores)

- VPS Oracle (ARM, ver `docs/superpowers/specs/2026-07-14-postador-automatico-design.md`), Coolify gerencia deploy via `POST /api/v1/applications/public` + `PATCH .../envs/bulk` + `GET /api/v1/deploy`.
- `project_uuid`, `server_uuid`, `environment_uuid` já conhecidos (mesmos usados por `render-service`/`whisper-service`, ver Task 9 de `docs/superpowers/plans/2026-07-15-render-whisper-services.md`).
- Repositório é o mesmo (`https://github.com/felippemarques/postador-automatico`), `base_directory` no Coolify aponta pra subpasta do serviço (`/render-service`, `/whisper-service`) — este plano cria `/tts-service`.
- Convenção de segurança já estabelecida: token de auth (`TTS_AUTH_TOKEN`) é gerado na hora do deploy e configurado via `envs/bulk`, nunca commitado.

## Task 1: Scaffold + health endpoint + bearer auth

**Files:**
- Create: `tts-service/requirements.txt`
- Create: `tts-service/requirements-dev.txt`
- Create: `tts-service/pytest.ini`
- Create: `tts-service/.dockerignore`
- Create: `tts-service/src/__init__.py`
- Create: `tts-service/src/server.py`
- Test: `tts-service/tests/test_server.py`

- [ ] **Step 1: Criar `requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
edge-tts==6.1.19
```

- [ ] **Step 2: Criar `requirements-dev.txt`**

```
-r requirements.txt
pytest==8.3.2
httpx==0.27.2
```

- [ ] **Step 3: Criar `pytest.ini`**

```ini
[pytest]
pythonpath = .
```

- [ ] **Step 4: Criar `.dockerignore`**

```
.venv
__pycache__
tests
```

- [ ] **Step 5: Criar `src/__init__.py` vazio**

Arquivo vazio (marca `src` como pacote Python).

- [ ] **Step 6: Criar ambiente virtual e instalar deps de dev**

Run:
```bash
cd tts-service && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
```
Expected: instala sem erro (nesta etapa `edge-tts` real é instalado, mas os testes não vão chamá-lo de verdade — ver Step 7).

- [ ] **Step 7: Escrever teste que falha (`test_server.py`)**

```python
# tts-service/tests/test_server.py
import os
os.environ["TTS_AUTH_TOKEN"] = "secret"

from fastapi.testclient import TestClient
from src.server import app

client = TestClient(app)


def test_health_ok():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_synthesize_requires_auth():
    res = client.post("/synthesize", json={"text": "oi", "voice": "pt-BR-AntonioNeural"})
    assert res.status_code == 401
```

- [ ] **Step 8: Rodar, confirmar falha**

Run: `cd tts-service && .venv/Scripts/pytest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.server'`

- [ ] **Step 9: Implementar `src/server.py` (health + auth, sem síntese ainda)**

```python
# tts-service/src/server.py
import os

from fastapi import FastAPI, Header, HTTPException

AUTH_TOKEN = os.environ["TTS_AUTH_TOKEN"]

app = FastAPI()


def check_auth(authorization):
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/synthesize")
def synthesize(payload: dict, authorization: str = Header(None)):
    check_auth(authorization)
    raise NotImplementedError
```

- [ ] **Step 10: Rodar, confirmar sucesso**

Run: `cd tts-service && .venv/Scripts/pytest -v`
Expected: PASS (2 testes)

- [ ] **Step 11: Commit**

```bash
git add tts-service/requirements.txt tts-service/requirements-dev.txt tts-service/pytest.ini tts-service/.dockerignore tts-service/src/__init__.py tts-service/src/server.py tts-service/tests/test_server.py
git commit -m "feat(tts-service): add health endpoint and bearer auth"
```

---

## Task 2: síntese de voz (`synthesize.py`)

**Files:**
- Create: `tts-service/src/synthesize.py`
- Test: `tts-service/tests/test_synthesize.py`

- [ ] **Step 1: Escrever teste que falha**

```python
# tts-service/tests/test_synthesize.py
import asyncio
import sys
import types


class FakeCommunicate:
    def __init__(self, text, voice):
        self.text = text
        self.voice = voice

    async def save(self, path):
        with open(path, "wb") as f:
            f.write(b"fake-mp3-bytes")


fake_edge_tts = types.ModuleType("edge_tts")
fake_edge_tts.Communicate = FakeCommunicate
sys.modules["edge_tts"] = fake_edge_tts

from src.synthesize import synthesize_speech  # noqa: E402


def test_synthesize_speech_writes_audio_file(tmp_path):
    out_path = tmp_path / "out.mp3"
    asyncio.run(synthesize_speech("Ola mundo", "pt-BR-AntonioNeural", str(out_path)))
    assert out_path.exists()
    assert out_path.read_bytes() == b"fake-mp3-bytes"
```

- [ ] **Step 2: Rodar, confirmar falha**

Run: `cd tts-service && .venv/Scripts/pytest tests/test_synthesize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.synthesize'`

- [ ] **Step 3: Implementar `synthesize.py`**

```python
# tts-service/src/synthesize.py
import edge_tts


async def synthesize_speech(text, voice, out_path):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_path)
    return out_path
```

- [ ] **Step 4: Rodar todos os testes, confirmar sucesso**

Run: `cd tts-service && .venv/Scripts/pytest -v`
Expected: PASS (3 testes no total)

- [ ] **Step 5: Commit**

```bash
git add tts-service/src/synthesize.py tts-service/tests/test_synthesize.py
git commit -m "feat(tts-service): implement edge-tts synthesis wrapper"
```

---

## Task 3: conectar `/synthesize` ao endpoint, servir arquivo, Dockerfile

**Files:**
- Modify: `tts-service/src/server.py`
- Modify: `tts-service/tests/test_server.py`
- Create: `tts-service/Dockerfile`

- [ ] **Step 1: Adicionar teste de sucesso do `/synthesize` com monkeypatch**

```python
# adicionar ao final de tts-service/tests/test_server.py
import src.server as server_module


def test_synthesize_success(monkeypatch, tmp_path):
    monkeypatch.setattr(server_module, "AUDIO_DIR", tmp_path)

    async def fake_synth(text, voice, out_path):
        with open(out_path, "wb") as f:
            f.write(b"fake-mp3-bytes")
        return out_path

    monkeypatch.setattr(server_module, "synthesize_speech", fake_synth)
    res = client.post(
        "/synthesize",
        json={"text": "Ola, heróis!", "voice": "pt-BR-AntonioNeural"},
        headers={"authorization": "Bearer secret"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["url"].startswith("/files/")
    assert body["url"].endswith(".mp3")


def test_synthesize_missing_fields_returns_400():
    res = client.post(
        "/synthesize",
        json={"text": "", "voice": ""},
        headers={"authorization": "Bearer secret"},
    )
    assert res.status_code == 400
```

- [ ] **Step 2: Rodar, confirmar falha**

Run: `cd tts-service && .venv/Scripts/pytest -v`
Expected: FAIL — endpoint ainda levanta `NotImplementedError`

- [ ] **Step 3: Implementar `/synthesize` completo e servir `/files` em `server.py`**

```python
# tts-service/src/server.py — substituir o arquivo inteiro
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles

from src.synthesize import synthesize_speech

AUTH_TOKEN = os.environ["TTS_AUTH_TOKEN"]
AUDIO_DIR = Path(os.environ.get("AUDIO_DIR", "/data/audio"))
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()


def check_auth(authorization):
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/synthesize")
async def synthesize(payload: dict, authorization: str = Header(None)):
    check_auth(authorization)
    text = payload.get("text")
    voice = payload.get("voice")
    if not text or not voice:
        raise HTTPException(status_code=400, detail="missing required fields")
    job_id = uuid.uuid4().hex
    out_path = AUDIO_DIR / f"{job_id}.mp3"
    await synthesize_speech(text, voice, str(out_path))
    return {"jobId": job_id, "url": f"/files/{job_id}.mp3"}


app.mount("/files", StaticFiles(directory=str(AUDIO_DIR)), name="files")
```

Nota: `AUDIO_DIR.mkdir` roda na importação do módulo — em teste local isso cria `/data/audio` se rodar como root, ou falha por permissão. Ajustar `AUDIO_DIR` via env var antes de importar em CI/local: `export AUDIO_DIR=/tmp/tts-audio` antes de rodar pytest (ver Step 4).

- [ ] **Step 4: Rodar com `AUDIO_DIR` local, confirmar sucesso**

Run:
```bash
cd tts-service && AUDIO_DIR=/tmp/tts-audio .venv/Scripts/pytest -v
```
Expected: PASS (5 testes no total)

- [ ] **Step 5: Criar `Dockerfile`**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
ENV AUDIO_DIR=/data/audio
EXPOSE 8000
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 6: Commit**

```bash
git add tts-service/src/server.py tts-service/tests/test_server.py tts-service/Dockerfile
git commit -m "feat(tts-service): wire synthesize endpoint, serve audio files, add dockerfile"
```

---

## Task 4: Deploy no Coolify

**Files:** nenhum arquivo de código — chamadas de API.

- [ ] **Step 1: Push do estado atual pro GitHub**

Run:
```bash
git push origin main
```

- [ ] **Step 2: Criar app `tts-service` no Coolify**

Run (mesmos `project_uuid`/`server_uuid`/`environment_uuid` usados em `render-service`/`whisper-service`):
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
    "name":"tts-service",
    "base_directory":"/tts-service",
    "ports_exposes":"8000",
    "instant_deploy":false
  }'
```

Expected: `201`, resposta com `uuid` e `domains`. Anote o `uuid` retornado como `TTS_APP_UUID`.

- [ ] **Step 3: Configurar env var `TTS_AUTH_TOKEN`**

Run (substituir `TTS_APP_UUID` pelo uuid do Step 2, gerar um valor novo de token):
```bash
curl -s -X PATCH "$BASE/api/v1/applications/TTS_APP_UUID/envs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{"data":[{"key":"TTS_AUTH_TOKEN","value":"<gerar novo valor — não versionar>"}]}'
```

Expected: `201`

- [ ] **Step 4: Deploy do tts-service**

Run:
```bash
curl -s "$BASE/api/v1/deploy?uuid=TTS_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200`, JSON com `deployments[0].deployment_uuid`.

Se o build falhar com erro de resolução da versão `edge-tts==6.1.19` (versão pode ter sido descontinuada no PyPI), trocar por `edge-tts>=6.1.0,<7` em `requirements.txt`, commitar, dar push e repetir o deploy.

- [ ] **Step 5: Confirmar app rodando**

Run:
```bash
curl -s "$BASE/api/v1/applications/TTS_APP_UUID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `"status":"running:healthy"`. Anote o `fqdn`/`domains` — é a URL que o n8n vai chamar no sub-workflow Voz.

---

## Task 5: Smoke test end-to-end e documentação

**Files:** nenhum arquivo de código.

- [ ] **Step 1: Testar `/health` público**

Run (trocar pela URL real anotada na Tarefa 4):
```bash
curl -s https://tts-service-TTS_APP_UUID.137.131.180.11.sslip.io/health
```
Expected: `{"status":"ok"}`

- [ ] **Step 2: Testar `/synthesize` com texto real da persona**

Run:
```bash
curl -s -X POST https://tts-service-TTS_APP_UUID.137.131.180.11.sslip.io/synthesize \
  -H "Authorization: Bearer <TTS_AUTH_TOKEN atual>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Atenção, Esquadrão! A missão de hoje é a Operação Super Ouvidos!","voice":"pt-BR-AntonioNeural"}'
```
Expected: `200`, JSON com `jobId` e `url` no formato `/files/<jobId>.mp3`. Baixar o arquivo (`curl -s https://.../files/<jobId>.mp3 -o teste.mp3`) e ouvir pra confirmar voz `pt-BR-AntonioNeural` audível e correta.

- [ ] **Step 3: Documentar a URL final**

Adicionar à seção "## Endpoints Publicados" de `docs/superpowers/specs/2026-07-14-postador-automatico-design.md` a entrada do `tts-service`, no mesmo formato das entradas existentes de `render-service`/`whisper-service`:

```markdown
- **tts-service**: `<URL real anotada na Tarefa 4>`
  - `GET /health` → `{"status":"ok"}`
  - `POST /synthesize` (Bearer `TTS_AUTH_TOKEN`) → `{"jobId", "url"}`
```

---

## Self-Review

- **Cobertura do gap identificado**: Voz do pipeline precisava de um jeito de chamar Edge-TTS via HTTP — resolvido pelo endpoint `/synthesize` deste plano. ✅
- **Sem placeholders de lógica**: todo código de cada passo está completo e executável; os únicos "trocar por valor real" são segredos (token, uuid) que nunca ficam versionados, igual ao padrão já usado no plano anterior. ✅
- **Consistência de tipos**: `synthesize_speech(text, voice, out_path)` usado igual em `synthesize.py`, `server.py` e testes; `AUDIO_DIR` mesmo nome em todos os pontos. ✅

## Próximo passo

Com a URL do `tts-service` publicada e validada, o sub-workflow "Voz" do plano `docs/superpowers/plans/2026-07-15-n8n-workflows-design.md` já tem os três serviços de que depende (`render-service`, `whisper-service`, `tts-service`) prontos. Próximo ciclo: escrever o plano de implementação dos workflows n8n em si, consumindo as três URLs.
