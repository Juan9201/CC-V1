"""Alinea el texto final de cada frase con el audio, no la transcripción vieja de Whisper."""

import gc
import re
import unicodedata
import wave
from pathlib import Path

from app.schemas.job import WordTick
from app.services.srt_io import Cue

_PAD = 0.35
_STAR = re.compile(r"\*+")
_PUNCT = re.compile(r"[^\w]+", re.UNICODE)
_model = None
_tokenizer = None
_aligner = None
_device = None


def spoken_token(text: str) -> str:
    """Deja solo letras para el alineador. Los asteriscos y los signos no se pronuncian."""
    cleaned = _STAR.sub("", text).lower().replace("ñ", "n")
    cleaned = "".join(
        char
        for char in unicodedata.normalize("NFD", cleaned)
        if unicodedata.category(char) != "Mn"
    )
    return _PUNCT.sub("", cleaned)


def _load() -> None:
    global _model, _tokenizer, _aligner, _device
    if _model is not None:
        return
    import torch
    from torchaudio.pipelines import MMS_FA as bundle

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    _model = bundle.get_model().to(_device)
    _model.eval()
    _tokenizer = bundle.get_tokenizer()
    _aligner = bundle.get_aligner()


def release() -> None:
    """Suelta el alineador para que el siguiente video pueda volver a cargar Whisper."""
    global _model, _tokenizer, _aligner
    _model = None
    _tokenizer = None
    _aligner = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        return


def _read_wav(path: Path) -> tuple[object, int]:
    import torch

    import array

    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    raw = array.array("h")
    raw.frombytes(frames)
    audio = torch.tensor(raw, dtype=torch.float32) / 32768.0
    if channels > 1:
        audio = audio.view(-1, channels).mean(dim=1)
    return audio, rate


def _window(cues: list[Cue], index: int, duration: float) -> tuple[float, float]:
    cue = cues[index]
    previous = cues[index - 1].end if index else 0.0
    following = cues[index + 1].start if index + 1 < len(cues) else duration
    start = max(previous, cue.start - _PAD, 0.0)
    end = min(following, cue.end + _PAD, duration)
    if end - start < 0.08:
        start, end = cue.start, max(cue.end, cue.start + 0.08)
    return start, end


def _align_slice(samples: object, rate: int, tokens: list[str]) -> list[tuple[float, float]] | None:
    import torch

    _load()
    assert _model is not None and _tokenizer is not None and _aligner is not None
    if samples.numel() < rate // 10:
        return None
    waveform = samples.view(1, -1).to(_device)
    with torch.inference_mode():
        emission, _ = _model(waveform)
    try:
        pieces = _tokenizer(tokens)
        spans = _aligner(emission[0], pieces)
    except Exception:
        return None
    if len(spans) != len(tokens):
        return None
    ratio = waveform.size(1) / emission.size(1)
    times: list[tuple[float, float]] = []
    for word_spans in spans:
        if not word_spans:
            return None
        start = word_spans[0].start * ratio / rate
        end = word_spans[-1].end * ratio / rate
        if end <= start:
            return None
        times.append((float(start), float(end)))
    return times


def align_cues(wav_path: Path, cues: list[Cue], on_progress=None) -> list[list[WordTick]]:
    """
    PROPÓSITO: Poner cada palabra del texto ya corregido sobre el audio de esa frase.
    CONEXIONES: MMS forced alignment. Una lista vacía avisa a la fusión de que use Whisper.
    """
    if not cues or not wav_path.is_file():
        return [[] for _ in cues]
    try:
        samples, rate = _read_wav(wav_path)
    except Exception:
        return [[] for _ in cues]
    duration = samples.shape[0] / rate
    aligned: list[list[WordTick]] = []
    total = len(cues)
    for index, cue in enumerate(cues):
        shown = [token for token in cue.text.split() if token.strip()]
        spoken = [spoken_token(token) for token in shown]
        usable = [(label, sound) for label, sound in zip(shown, spoken) if sound]
        if not usable:
            aligned.append([])
        else:
            win_start, win_end = _window(cues, index, duration)
            left = max(0, int(win_start * rate))
            right = min(samples.shape[0], int(win_end * rate))
            times = None
            try:
                times = _align_slice(samples[left:right], rate, [sound for _, sound in usable])
            except Exception:
                times = None
            if times is None:
                aligned.append([])
            else:
                ticks: list[WordTick] = []
                for (label, _), (start, end) in zip(usable, times):
                    ticks.append(
                        WordTick(
                            start=win_start + start,
                            end=min(win_end, win_start + end),
                            text=label,
                            lang="es",
                        )
                    )
                aligned.append(ticks if len(ticks) == len(usable) else [])
        if on_progress is not None:
            on_progress(index + 1, total)
    return aligned
