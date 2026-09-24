import threading
from pathlib import Path

from app.services.srt_io import Cue, SpokenWord, group_words, word_language

_model = None
_lock = threading.Lock()


def bind_model(model: object) -> None:
    """Guarda el modelo creado en el hilo worker. Las transcripciones salen de ese mismo hilo."""
    global _model
    with _lock:
        _model = model


def get_model() -> object:
    """
    PROPÓSITO: Devolver el Whisper cargado en el hilo de la GPU.
    CONEXIONES: faster-whisper en CUDA. La primera construcción ocurre en el worker.
    """
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from faster_whisper import WhisperModel

                _model = WhisperModel("medium", device="cuda", compute_type="float16")
    return _model


def _agent_log(hypothesis_id: str, message: str, data: dict) -> None:
    # #region agent log
    import json
    import time

    payload = {
        "sessionId": "03e0cf",
        "runId": "pre-fix",
        "hypothesisId": hypothesis_id,
        "location": "whisper_engine.py:transcribe_spanish",
        "message": message,
        "data": data,
        "timestamp": int(time.time() * 1000),
    }
    with open(r"c:\AI CC\debug-03e0cf.log", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    # #endregion


def transcribe_spanish(audio_path: Path) -> tuple[list[Cue], list[SpokenWord]]:
    """
    PROPÓSITO: Alinear palabras del audio ya cortado, aunque la clase mezcle español e inglés.
    CONEXIONES: faster-whisper en CUDA, sin un segundo recorte VAD. El idioma lo detecta el modelo.
    """
    segments, info = get_model().transcribe(
        str(audio_path),
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
    )
    # #region agent log
    _agent_log(
        "A",
        "language locked for the whole file",
        {
            "language": info.language,
            "probability": round(float(info.language_probability), 4),
            "top": [[code, round(float(prob), 4)] for code, prob in (info.all_language_probs or [])[:5]],
            "duration": round(float(info.duration), 3),
        },
    )
    # #endregion
    words: list[SpokenWord] = []
    segment_texts: list[str] = []
    for segment in segments:
        segment_texts.append(segment.text.strip())
        if segment.words:
            for word in segment.words:
                token = word.word.strip()
                if token:
                    words.append(SpokenWord(float(word.start), float(word.end), token, word_language(token)))
            continue
        text = segment.text.strip()
        if text:
            words.append(SpokenWord(float(segment.start), float(segment.end), text, word_language(text)))

    # #region agent log
    joined = " ".join(segment_texts)
    _agent_log(
        "C",
        "whisper text before DeepSeek",
        {
            "segments": segment_texts[:12],
            "hasDai": "DAI" in joined or "Dai" in joined,
            "hasJain": "Jain" in joined or "jain" in joined.lower(),
            "hasDie": "Die" in joined or "die" in joined.lower(),
            "hasJane": "Jane" in joined or "jane" in joined.lower(),
        },
    )
    # #endregion

    return group_words(words), words
