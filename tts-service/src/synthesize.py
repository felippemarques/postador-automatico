import edge_tts


async def synthesize_speech(text, voice, out_path):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_path)
    return out_path
