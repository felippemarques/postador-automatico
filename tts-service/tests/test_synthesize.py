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
