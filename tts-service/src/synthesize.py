async def synthesize_speech(text, voice, out_path):
    import edge_tts

    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_path)
    return out_path
