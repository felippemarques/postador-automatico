# whisper-service/tests/test_transcribe.py
from types import SimpleNamespace
from src.transcribe import transcribe_audio


class FakeWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class FakeSegment:
    def __init__(self, text, start, end, words):
        self.text = text
        self.start = start
        self.end = end
        self.words = words


class FakeModel:
    def transcribe(self, path, word_timestamps=True):
        segments = [
            FakeSegment(" Ola mundo", 0.0, 1.2, [FakeWord("Ola", 0.0, 0.5), FakeWord("mundo", 0.5, 1.2)]),
        ]
        return segments, SimpleNamespace(language="pt")


def test_transcribe_audio_returns_text_segments_and_words():
    result = transcribe_audio("fake.mp3", FakeModel())
    assert result["text"] == "Ola mundo"
    assert result["segments"] == [{"text": "Ola mundo", "start": 0.0, "end": 1.2}]
    assert result["words"] == [
        {"word": "Ola", "start": 0.0, "end": 0.5},
        {"word": "mundo", "start": 0.5, "end": 1.2},
    ]
