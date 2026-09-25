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


def release_model() -> None:
    """Suelta Whisper de la GPU antes de cargar el alineador del texto final."""
    global _model
    with _lock:
        _model = None
    import gc

    gc.collect()


def transcribe_spanish(audio_path: Path, on_progress=None) -> tuple[list[Cue], list[SpokenWord]]:
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
    words: list[SpokenWord] = []
    duration = max(float(info.duration or 0), 0.001)
    for segment in segments:
        batch = segment.words or []
        if batch:
            for word in batch:
                token = word.word.strip()
                if not token:
                    continue
                words.append(SpokenWord(float(word.start), float(word.end), token, word_language(token)))
                if on_progress is not None:
                    on_progress(min(1.0, float(word.end) / duration), len(words), token)
            continue
        text = segment.text.strip()
        if text:
            words.append(SpokenWord(float(segment.start), float(segment.end), text, word_language(text)))
            if on_progress is not None:
                on_progress(min(1.0, float(segment.end) / duration), len(words), text)

    return group_words(words), words
