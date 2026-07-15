def transcribe_audio(path, model):
    segments, _info = model.transcribe(path, word_timestamps=True)
    seg_list = []
    words = []
    for seg in segments:
        seg_list.append({"text": seg.text.strip(), "start": seg.start, "end": seg.end})
        for w in (seg.words or []):
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    full_text = " ".join(s["text"] for s in seg_list)
    return {"text": full_text, "segments": seg_list, "words": words}
