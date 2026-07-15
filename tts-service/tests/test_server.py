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
