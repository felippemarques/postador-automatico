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
