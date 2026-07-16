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
