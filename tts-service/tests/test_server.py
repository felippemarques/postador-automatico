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
