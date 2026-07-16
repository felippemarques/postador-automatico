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
    out_path = AUDIO_DIR / f"{job_id}.wav"
    await synthesize_speech(text, voice, str(out_path))
    return {"jobId": job_id, "url": f"/files/{job_id}.wav"}


app.mount("/files", StaticFiles(directory=str(AUDIO_DIR)), name="files")
