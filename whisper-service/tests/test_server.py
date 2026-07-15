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
