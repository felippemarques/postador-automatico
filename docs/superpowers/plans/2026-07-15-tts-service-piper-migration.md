# tts-service — Migração pra Piper TTS (offline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir Edge-TTS por Piper TTS (motor neural local/offline) dentro do `tts-service` já publicado — Edge-TTS depende de um endpoint não documentado da Microsoft (`speech.platform.bing.com`) que **bloqueia com 403 requisições vindas da faixa de IP da VPS Oracle Cloud** (confirmado nesta sessão: mesmo código funciona perfeitamente de outra rede, então não é bug nosso, é bloqueio anti-abuso do lado deles contra IPs de datacenter/cloud). Piper roda 100% local, sem chamada de rede em runtime — mesmo padrão já usado por `whisper-service`/`faster-whisper`, que nunca teve esse problema.

**Architecture:** `synthesize.py` passa a invocar o binário `piper` (instalado via pacote PyPI `piper-tts`) via subprocesso local, com o modelo de voz `.onnx` baixado **durante o build da imagem Docker** (não em runtime) do repositório público `rhasspy/piper-voices` no Hugging Face. Contrato do endpoint `/synthesize` não muda (`{text, voice} → {jobId, url}`), só o formato do arquivo gerado passa de `.mp3` pra `.wav` (Piper gera WAV nativamente; `render-service` já consome áudio pelo conteúdo real do arquivo via ffmpeg, não pela extensão da URL, então isso não quebra nada a jusante).

**Tech Stack:** `piper-tts` (PyPI, inclui binário `piper` + bindings), modelo `pt_BR-faber-medium` (Hugging Face `rhasspy/piper-voices`), `asyncio.subprocess`.

---

## Contexto (achado nesta sessão)

- `tts-service` (plano `docs/superpowers/plans/2026-07-15-tts-service.md`) foi implementado e deployado com sucesso — `/health` e a lógica toda funcionam. O único problema é a chamada real ao backend da Microsoft, que retorna `403 WSServerHandshakeError` **especificamente** quando originada do IP da VPS.
- Confirmado por teste direto (fora da VPS, em outra rede): o mesmo código Python com `edge_tts.Communicate(...).save(...)` funciona perfeitamente e gera um mp3 real e válido. Ou seja, é 100% um bloqueio de IP do lado da Microsoft, não um bug de implementação.
- `render-service` já teve isso resolvido de forma equivalente: `faster-whisper` roda localmente no `whisper-service`, sem dependência de API externa — este plano aplica a mesma filosofia ao `tts-service`.
- App já existe no Coolify (`uuid: ha2pmlzqqxtr8c8szjt0mfz6`, domínio `http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io`), `TTS_AUTH_TOKEN` já configurado — este plano só precisa fazer *redeploy* do mesmo app, não criar um novo.

## Task 1: `synthesize.py` — trocar Edge-TTS por Piper (subprocesso local)

**Files:**
- Modify: `tts-service/src/synthesize.py`
- Modify: `tts-service/requirements.txt`
- Modify: `tts-service/tests/test_synthesize.py`

- [ ] **Step 1: Atualizar `requirements.txt`** (remover `edge-tts`, adicionar `piper-tts`)

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
piper-tts==1.2.0
```

Se `piper-tts==1.2.0` não existir mais no PyPI no momento do build, trocar por `piper-tts>=1.2,<2` e reinstalar.

- [ ] **Step 2: Escrever teste que falha (`test_synthesize.py`) — substituir o arquivo inteiro**

```python
# tts-service/tests/test_synthesize.py
import asyncio

from src.synthesize import build_piper_args, run_piper, synthesize_speech


def test_build_piper_args_returns_expected_argv():
    args = build_piper_args("/models/voice.onnx", "/tmp/out.wav")
    assert args == ["piper", "--model", "/models/voice.onnx", "--output_file", "/tmp/out.wav"]


def test_run_piper_success_with_injected_subprocess():
    class FakeProcess:
        returncode = 0

        async def communicate(self, input=None):
            return (b"", b"")

    async def fake_create_subprocess(*args, **kwargs):
        assert args == ("piper", "--model", "/models/voice.onnx", "--output_file", "/tmp/out.wav")
        return FakeProcess()

    asyncio.run(
        run_piper(
            ["piper", "--model", "/models/voice.onnx", "--output_file", "/tmp/out.wav"],
            "Ola mundo",
            create_subprocess=fake_create_subprocess,
        )
    )


def test_run_piper_raises_on_nonzero_exit():
    class FakeProcess:
        returncode = 1

        async def communicate(self, input=None):
            return (b"", b"piper: model not found")

    async def fake_create_subprocess(*args, **kwargs):
        return FakeProcess()

    try:
        asyncio.run(
            run_piper(
                ["piper", "--model", "/models/voice.onnx", "--output_file", "/tmp/out.wav"],
                "Ola mundo",
                create_subprocess=fake_create_subprocess,
            )
        )
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "model not found" in str(e)


def test_synthesize_speech_wires_args_and_calls_run_piper(monkeypatch, tmp_path):
    calls = []

    async def fake_run_piper(args, text, create_subprocess=None):
        calls.append((args, text))

    import src.synthesize as synthesize_module

    monkeypatch.setattr(synthesize_module, "run_piper", fake_run_piper)
    out_path = str(tmp_path / "out.wav")
    asyncio.run(synthesize_speech("Ola, herois!", "pt-BR-AntonioNeural", out_path, model_path="/models/voice.onnx"))
    assert calls == [(["piper", "--model", "/models/voice.onnx", "--output_file", out_path], "Ola, herois!")]
```

- [ ] **Step 3: Rodar, confirmar falha**

Run: `cd tts-service && AUDIO_DIR=/tmp/tts-audio .venv/Scripts/pytest tests/test_synthesize.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_piper_args' from 'src.synthesize'`

- [ ] **Step 4: Reinstalar deps no venv local** (troca de dependência)

Run:
```bash
cd tts-service && .venv/Scripts/pip install -r requirements-dev.txt
```
Expected: instala `piper-tts` sem erro (não precisamos do modelo `.onnx` localmente pra rodar os testes — eles usam um subprocesso local fake, não o binário real).

- [ ] **Step 5: Implementar `synthesize.py` — substituir o arquivo inteiro**

```python
# tts-service/src/synthesize.py
import asyncio
import os

_create_subprocess = asyncio.create_subprocess_exec

MODEL_PATH = os.environ.get("PIPER_MODEL_PATH", "/app/models/pt_BR-faber-medium.onnx")


def build_piper_args(model_path, out_path):
    return ["piper", "--model", model_path, "--output_file", out_path]


async def run_piper(args, text, create_subprocess=_create_subprocess):
    proc = await create_subprocess(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate(input=text.encode("utf-8"))
    if proc.returncode != 0:
        raise RuntimeError(f"piper failed: {stderr.decode(errors='replace')}")


async def synthesize_speech(text, voice, out_path, model_path=None):
    args = build_piper_args(model_path or MODEL_PATH, out_path)
    await run_piper(args, text)
    return out_path
```

Nota: o parâmetro `voice` é mantido na assinatura só por compatibilidade com quem chama (`server.py` continua passando `voice` sem mudar) — o Piper deste plano usa um único modelo local fixo (`pt_BR-faber-medium`), não múltiplas vozes por nome. Se no futuro precisar de mais de uma voz, trocar `MODEL_PATH` fixo por um mapeamento `voice → model_path`.

- [ ] **Step 6: Rodar todos os testes, confirmar sucesso**

Run: `cd tts-service && AUDIO_DIR=/tmp/tts-audio .venv/Scripts/pytest -v`
Expected: PASS (todos os testes de `test_synthesize.py` novos + os de `test_server.py` inalterados — `test_server.py` monkeypatcha `synthesize_speech` diretamente, então não é afetado por essa troca interna)

- [ ] **Step 7: Commit**

```bash
git add tts-service/src/synthesize.py tts-service/requirements.txt tts-service/tests/test_synthesize.py
git commit -m "feat(tts-service): replace edge-tts with local piper TTS (Microsoft blocks VPS IP range)"
```

---

## Task 2: `server.py` (extensão `.wav`) + Dockerfile (baixar modelo no build)

**Files:**
- Modify: `tts-service/src/server.py`
- Modify: `tts-service/tests/test_server.py`
- Modify: `tts-service/Dockerfile`

- [ ] **Step 1: Atualizar `server.py`** — trocar as duas ocorrências de `.mp3` por `.wav`

```python
# tts-service/src/server.py — trecho a alterar dentro de synthesize()
    job_id = uuid.uuid4().hex
    out_path = AUDIO_DIR / f"{job_id}.wav"
    await synthesize_speech(text, voice, str(out_path))
    return {"jobId": job_id, "url": f"/files/{job_id}.wav"}
```

(resto do arquivo permanece idêntico — só essas duas linhas mudam `.mp3` → `.wav`)

- [ ] **Step 2: Atualizar `test_server.py`** — trocar as asserções de extensão

Em `test_synthesize_success`, trocar:
```python
    assert body["url"].endswith(".mp3")
```
por:
```python
    assert body["url"].endswith(".wav")
```

- [ ] **Step 3: Rodar, confirmar sucesso**

Run: `cd tts-service && AUDIO_DIR=/tmp/tts-audio .venv/Scripts/pytest -v`
Expected: PASS (todos os testes)

- [ ] **Step 4: Atualizar `Dockerfile`** — instalar `curl` e baixar o modelo de voz no build

```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /app/models && \
    curl -L -o /app/models/pt_BR-faber-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx && \
    curl -L -o /app/models/pt_BR-faber-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json
COPY src ./src
ENV AUDIO_DIR=/data/audio
ENV PIPER_MODEL_PATH=/app/models/pt_BR-faber-medium.onnx
EXPOSE 8000
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
```

Se as URLs do Hugging Face retornarem 404 no momento do build (o layout de diretórios do repo `rhasspy/piper-voices` pode mudar), navegar `https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR` pra achar o locutor/qualidade disponível atual e ajustar as duas URLs (mantendo o mesmo par `.onnx` + `.onnx.json`).

- [ ] **Step 5: Commit**

```bash
git add tts-service/src/server.py tts-service/tests/test_server.py tts-service/Dockerfile
git commit -m "feat(tts-service): serve wav output, download piper voice model at build time"
```

---

## Task 3: Redeploy no Coolify (mesmo app, sem criar novo)

**Files:** nenhum arquivo de código — chamadas de API.

- [ ] **Step 1: Push pro GitHub**

Run:
```bash
git push origin main
```

- [ ] **Step 2: Disparar redeploy do app já existente**

Run (mesmo `TTS_APP_UUID` do plano anterior — `ha2pmlzqqxtr8c8szjt0mfz6` nesta instância, confirmar se ainda é o mesmo antes de rodar):
```bash
TOKEN="<obter com o operador — não versionar>"
BASE="http://137.131.180.11:8000"
curl -s "$BASE/api/v1/deploy?uuid=ha2pmlzqqxtr8c8szjt0mfz6" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
```

Expected: `200`, JSON com novo `deployment_uuid`. O build agora demora mais que antes (baixa o modelo `.onnx` de ~60-100MB durante o build) — acompanhar via `GET /api/v1/applications/{uuid}/logs` ou dashboard do Coolify até o status estabilizar (usar o `uuid` do app, **não** confundir com o status do proxy Traefik dentro do mesmo payload — ambos aparecem como `"status":"..."` na resposta bruta).

- [ ] **Step 3: Confirmar app rodando**

Run:
```bash
curl -s http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io/health
```
Expected: `{"status":"ok"}`

---

## Task 4: Smoke test real + atualizar documentação

**Files:** nenhum arquivo de código.

- [ ] **Step 1: Testar `/synthesize` com texto real da persona**

Run:
```bash
TTS_AUTH_TOKEN="<valor atual configurado no Coolify>"
curl -s -X POST http://ha2pmlzqqxtr8c8szjt0mfz6.137.131.180.11.sslip.io/synthesize \
  -H "Authorization: Bearer $TTS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Atencao, Esquadrao! A missao de hoje e a Operacao Super Ouvidos!","voice":"pt-BR-AntonioNeural"}'
```
Expected: `200`, JSON com `jobId` e `url` terminando em `.wav`. Baixar o arquivo e ouvir pra confirmar áudio real em português.

Nota: se o texto tiver acentuação (`ã`, `ç`, etc.) e o `curl` do seu terminal não estiver em UTF-8, pode dar erro de parsing do body — nesse caso testar sem acentos primeiro pra isolar, e usar `--data-binary @arquivo.json` com um arquivo UTF-8 se precisar validar acentuação.

- [ ] **Step 2: Confirmar ausência de dependência de rede em runtime**

Checar os logs do container (`GET /api/v1/applications/{uuid}/logs`) durante a chamada acima — não deve aparecer nenhuma tentativa de conexão de rede de saída (websocket, HTTP) além da própria requisição recebida. Isso confirma que a síntese é 100% local.

- [ ] **Step 3: Atualizar a documentação**

Atualizar a entrada do `tts-service` na seção "## Endpoints Publicados" de `docs/superpowers/specs/2026-07-14-postador-automatico-design.md` (adicionada pelo plano anterior) pra refletir: motor trocado pra Piper TTS local (offline), formato de saída agora `.wav` em vez de `.mp3`, e a razão da troca (bloqueio de IP do Edge-TTS pela Microsoft nesta VPS).

## Self-Review

- **Cobertura**: resolve o bloqueio de IP confirmado nesta sessão trocando pra síntese 100% local — elimina a dependência de rede externa em runtime por completo. ✅
- **Sem placeholders de lógica**: todo código de cada passo está completo; únicos "trocar por valor real" são segredos (token) e a URL exata do modelo (com fallback documentado caso o layout do HF mude). ✅
- **Consistência de tipos**: assinatura `synthesize_speech(text, voice, out_path, model_path=None)` usada de forma consistente entre `synthesize.py` e os testes; `server.py` não muda a chamada (`synthesize_speech(text, voice, str(out_path))`, `model_path` fica com default). ✅
- **Blast radius contido**: `server.py` só muda 2 linhas (extensão do arquivo); a troca de motor fica isolada em `synthesize.py`/`requirements.txt`/`Dockerfile`. ✅
