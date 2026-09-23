import threading
from pathlib import Path

from app.services.srt_io import Cue, group_words

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


def transcribe_spanish(audio_path: Path) -> list[Cue]:
    """
    PROPÓSITO: Alinear palabras del audio ya cortado, aunque la clase mezcle español e inglés.
    CONEXIONES: faster-whisper en CUDA, sin un segundo recorte VAD. El idioma lo detecta el modelo.
    """
    segments, _info = get_model().transcribe(
        str(audio_path),
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
    )
    words: list[tuple[float, float, str]] = []
    for segment in segments:
        if segment.words:
            for word in segment.words:
                words.append((float(word.start), float(word.end), word.word))
            continue
        text = segment.text.strip()
        if text:
            words.append((float(segment.start), float(segment.end), text))

    return group_words(words)
