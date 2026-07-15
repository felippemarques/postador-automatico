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
