"""Mide la apertura de la boca y el desfase fijo entre esa imagen y el audio."""

import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from app.services.ffmpeg_silence import ffmpeg_executable

_FPS = 12
_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
_UPPER = 13
_LOWER = 14
_LEFT = 78
_RIGHT = 308


@dataclass(frozen=True)
class MouthTrack:
    opens: list[float]
    closes: list[float]
    offset: float


def _model_path() -> Path:
    dest = Path(__file__).resolve().parents[2] / "models" / "face_landmarker.task"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.is_file() or dest.stat().st_size < 1_000_000:
        urllib.request.urlretrieve(_MODEL_URL, dest)
    return dest


def _frames(video: Path, work: Path) -> list[Path]:
    folder = work / "lips"
    if folder.exists():
        for old in folder.glob("*.png"):
            old.unlink()
    folder.mkdir(parents=True, exist_ok=True)
    pattern = folder / "f%06d.png"
    subprocess.run(
        [
            ffmpeg_executable(),
            "-y",
            "-i",
            str(video),
            "-vf",
            f"fps={_FPS}",
            "-q:v",
            "5",
            str(pattern),
        ],
        check=True,
        capture_output=True,
    )
    return sorted(folder.glob("f*.png"))


def _mouth_series(frames: list[Path], on_progress=None):
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks.python.core.base_options import BaseOptions
    from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions

    options = FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(_model_path())),
        num_faces=1,
    )
    series = np.zeros(len(frames), dtype=np.float64)
    with FaceLandmarker.create_from_options(options) as landmarker:
        for index, frame in enumerate(frames):
            image = mp.Image.create_from_file(str(frame))
            result = landmarker.detect(image)
            if result.face_landmarks:
                marks = result.face_landmarks[0]
                upper, lower = marks[_UPPER], marks[_LOWER]
                left, right = marks[_LEFT], marks[_RIGHT]
                height = ((upper.y - lower.y) ** 2 + (upper.x - lower.x) ** 2) ** 0.5
                width = max(1e-4, ((left.x - right.x) ** 2 + (left.y - right.y) ** 2) ** 0.5)
                series[index] = height / width
            if on_progress is not None and (index % 12 == 0 or index + 1 == len(frames)):
                on_progress(index + 1, len(frames))
    if len(series) >= 3:
        kernel = np.array([1, 2, 1], dtype=np.float64) / 4
        series = np.convolve(series, kernel, mode="same")
    return series


def _edges(series) -> tuple[list[float], list[float]]:
    import numpy as np
    if series.size == 0 or float(series.max()) <= 0:
        return [], []
    low = float(np.percentile(series, 40))
    high = float(np.percentile(series, 75))
    gate = low + 0.45 * (high - low)
    opens: list[float] = []
    closes: list[float] = []
    open_now = series[0] >= gate
    for index in range(1, series.size):
        speaking = series[index] >= gate
        if speaking and not open_now:
            opens.append(index / _FPS)
        elif open_now and not speaking:
            closes.append(index / _FPS)
        open_now = speaking
    return opens, closes


def _rms(wav_path: Path, count: int):
    import wave

    import numpy as np

    with wave.open(str(wav_path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float64)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if count <= 0 or audio.size == 0:
        return np.zeros(max(count, 1))
    hop = max(1, int(rate / _FPS))
    energy = np.zeros(count, dtype=np.float64)
    for index in range(count):
        piece = audio[index * hop : (index + 1) * hop]
        if piece.size:
            energy[index] = float(np.sqrt(np.mean(piece * piece)))
    return energy


def _offset(mouth, energy) -> float:
    import numpy as np
    if mouth.size < 4 or energy.size < 4:
        return 0.0
    limit = int(0.5 * _FPS)
    left = mouth - mouth.mean()
    right = energy - energy.mean()
    if float(np.max(np.abs(left))) < 1e-6 or float(np.max(np.abs(right))) < 1e-6:
        return 0.0
    best_lag = 0
    best_score = -1e18
    for lag in range(-limit, limit + 1):
        if lag < 0:
            score = float(np.dot(left[-lag:], right[: lag or None]))
        elif lag > 0:
            score = float(np.dot(left[:-lag], right[lag:]))
        else:
            score = float(np.dot(left, right[: left.size]))
        if score > best_score:
            best_score = score
            best_lag = lag
    offset = best_lag / _FPS
    return offset if abs(offset) > 0.04 else 0.0


def measure(video: Path, wav_path: Path, work: Path, on_progress=None) -> MouthTrack:
    """
    PROPÓSITO: Ver cuándo se abre y se cierra la boca, y si la imagen va corrida del audio.
    CONEXIONES: FFmpeg a 12 fps y MediaPipe Face Landmarker. Sin cara, la fusión no mueve tiempos.
    """
    try:
        frames = _frames(video, work)
        if not frames:
            return MouthTrack([], [], 0.0)
        series = _mouth_series(frames, on_progress)
        opens, closes = _edges(series)
        offset = _offset(series, _rms(wav_path, len(frames)))
        return MouthTrack(opens, closes, offset)
    except Exception:
        return MouthTrack([], [], 0.0)
