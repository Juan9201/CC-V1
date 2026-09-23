import math
import re
import subprocess
from pathlib import Path

import ffmpeg

from app.config import settings

_START = re.compile(r"silence_start:\s*([0-9.]+)")
_END = re.compile(r"silence_end:\s*([0-9.]+)")
_ffmpeg_bin: str | None = None
_ffprobe_bin: str | None = None


def _bundled_executable(name: str) -> str | None:
    """FFmpeg 8.0 abre h264_nvenc con el driver 591. FFmpeg 9 pide el driver 610."""
    root = Path(__file__).resolve().parents[2] / "tools" / "ffmpeg8"
    if not root.is_dir():
        return None
    found = next(root.glob(f"**/bin/{name}.exe"), None)
    if found is None or not found.is_file():
        return None
    return str(found)


def ffmpeg_executable() -> str:
    global _ffmpeg_bin
    if _ffmpeg_bin is None:
        _ffmpeg_bin = _bundled_executable("ffmpeg") or "ffmpeg"
    return _ffmpeg_bin


def ffprobe_executable() -> str:
    global _ffprobe_bin
    if _ffprobe_bin is None:
        _ffprobe_bin = _bundled_executable("ffprobe") or "ffprobe"
    return _ffprobe_bin


def probe_durations(path: Path) -> dict[str, float]:
    """
    PROPÓSITO: Medir la duración de contenedor, video y audio ya reproducibles.
    CONEXIONES: ffprobe.
    """
    probe = ffmpeg.probe(str(path), cmd=ffprobe_executable())
    measured: dict[str, float] = {"format": float(probe["format"]["duration"])}
    for stream in probe["streams"]:
        kind = stream.get("codec_type")
        if kind not in {"video", "audio"}:
            continue
        if stream.get("duration") is not None:
            measured[kind] = float(stream["duration"])
        if stream.get("start_time") is not None:
            measured[f"{kind}_start"] = float(stream["start_time"])
    return measured


def video_frame_rate(path: Path) -> tuple[int, int]:
    """Devuelve el frame rate del video como numerador y denominador."""
    probe = ffmpeg.probe(str(path), cmd=ffprobe_executable())
    for stream in probe["streams"]:
        if stream.get("codec_type") != "video":
            continue
        rate = str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "30/1")
        num_s, den_s = rate.split("/")
        num, den = int(num_s), int(den_s)
        if num > 0 and den > 0:
            return num, den
    return 30, 1


def snap_up_to_frame(seconds: float, fps_num: int, fps_den: int) -> float:
    """Sube la duración al siguiente frame para que el video no corte el último tramo."""
    frames = math.ceil((seconds * fps_num / fps_den) - 1e-9)
    return frames * fps_den / fps_num


def media_duration(path: Path) -> float:
    """
    PROPÓSITO: Leer la duración del contenedor antes de invertir los silencios.
    CONEXIONES: ffprobe, a través de ffmpeg-python.
    """
    return probe_durations(path)["format"]


def detect_silences(path: Path) -> list[tuple[float, float]]:
    """
    PROPÓSITO: Localizar tramos por debajo del umbral con silencedetect.
    CONEXIONES: FFmpeg. El filtro escribe los tiempos en stderr.
    """
    stream = ffmpeg.input(str(path)).output(
        "pipe:",
        format="null",
        af=f"silencedetect=noise={settings.silence_noise_db}:d={settings.silence_min_duration}",
    )
    try:
        _stdout, stderr = ffmpeg.run(
            stream,
            cmd=ffmpeg_executable(),
            capture_stdout=True,
            capture_stderr=True,
        )
    except ffmpeg.Error as exc:
        stderr = exc.stderr or b""

    log = stderr.decode("utf-8", errors="replace")
    starts = [float(value) for value in _START.findall(log)]
    ends = [float(value) for value in _END.findall(log)]
    duration = media_duration(path)
    if len(starts) == len(ends) + 1:
        ends.append(duration)
    return [(start, end) for start, end in zip(starts, ends, strict=False) if end > start]


def speech_ranges(
    silences: list[tuple[float, float]], duration: float
) -> list[tuple[float, float]]:
    """
    PROPÓSITO: Convertir silencios en tramos de voz que se conservan.
    CONEXIONES: Ninguna.

    El pad deja un resto corto de silencio en cada borde para no cortar la cola de la palabra.
    """
    pad = settings.silence_pad
    keeps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in silences:
        cut_start = start + pad
        cut_end = end - pad
        if cut_end <= cut_start:
            continue
        if cut_start - cursor >= 0.08:
            keeps.append((cursor, cut_start))
        cursor = max(cursor, cut_end)
    if duration - cursor >= 0.08:
        keeps.append((cursor, duration))
    return keeps or [(0.0, duration)]


def _run(stream: ffmpeg.nodes.OutputStream, extra_args: list[str] | None = None) -> None:
    """Ejecuta el grafo. extra_args se insertan delante del archivo de salida."""
    argv = ffmpeg.compile(stream, cmd=ffmpeg_executable(), overwrite_output=True)
    if extra_args:
        # compile() termina en [archivo_salida, -y]. -map tiene que ir antes del archivo.
        if argv[-1] == "-y":
            argv = argv[:-2] + extra_args + argv[-2:]
        else:
            argv = argv[:-1] + extra_args + argv[-1:]
    completed = subprocess.run(argv, capture_output=True)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace")[-1800:]
        if "minimum required Nvidia driver" in detail:
            raise RuntimeError(
                "h264_nvenc no abrió. Este FFmpeg exige el driver NVIDIA 610 o más nuevo "
                "y el instalado expone NVENC API 13.0."
            )
        raise RuntimeError(detail)


def render_without_silence(
    source: Path,
    dest: Path,
    work_dir: Path,
    *,
    vcodec: str = "h264_nvenc",
) -> dict[str, float]:
    """
    PROPÓSITO: Quitar silencios en un solo encode NVENC para conservar una línea de tiempo.
    CONEXIONES: FFmpeg / h264_nvenc.
    """
    duration = media_duration(source)
    silences = detect_silences(source)
    keeps = speech_ranges(silences, duration)
    work_dir.mkdir(parents=True, exist_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    for index, (start, end) in enumerate(keeps):
        lines.append(
            f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{index}]"
        )
        lines.append(
            f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{index}]"
        )
    if len(keeps) == 1:
        lines.append("[v0]null[v]")
        lines.append("[a0]anull[a]")
    else:
        joined = "".join(f"[v{index}][a{index}]" for index in range(len(keeps)))
        lines.append(f"{joined}concat=n={len(keeps)}:v=1:a=1[v][a]")
    # El AAC solo escribe frames de 1024 muestras y se queda corto frente al video.
    lines.append("[a]apad=pad_dur=0.05[ap]")

    graph = ";\n".join(lines)
    expected = sum(end - start for start, end in keeps)
    fps_num, fps_den = video_frame_rate(source)
    target = snap_up_to_frame(expected, fps_num, fps_den)
    # FFmpeg 9 eliminó -filter_complex_script. El grafo viaja en -filter_complex.
    (work_dir / "cut.ffscript").write_text(graph + "\n", encoding="utf-8")

    encode_options: dict[str, str] = {"b:a": "160k", "movflags": "+faststart"}
    if vcodec == "h264_nvenc":
        encode_options.update({"preset": "p4", "rc": "vbr", "cq": "23", "b:v": "0"})
    else:
        encode_options.update({"preset": "veryfast", "crf": "18"})

    incoming = ffmpeg.input(str(source))
    stream = ffmpeg.output(
        incoming,
        str(dest),
        filter_complex=graph,
        vcodec=vcodec,
        acodec="aac",
        pix_fmt="yuv420p",
        **encode_options,
    )
    _run(stream, ["-map", "[v]", "-map", "[ap]", "-t", f"{target:.6f}"])
    return probe_durations(dest)


def extract_whisper_wav(source: Path, dest: Path) -> dict[str, float]:
    """
    PROPÓSITO: Extraer el audio del MP4 ya cortado a WAV 16 kHz mono.
    CONEXIONES: FFmpeg. Este WAV es el reloj que después usa Whisper.
    """
    video = probe_durations(source)
    limit = f"{video.get('video', video['format']):.6f}"
    stream = ffmpeg.input(str(source)).output(
        str(dest),
        t=limit,
        ac=1,
        ar=16000,
        format="wav",
        acodec="pcm_s16le",
    )
    _run(stream)
    return probe_durations(dest)


def burn_subtitles(video: Path, subtitles: Path, dest: Path) -> None:
    """
    PROPÓSITO: Dibujar un SRT sobre una copia del video ya cortado.
    CONEXIONES: FFmpeg libass y h264_nvenc. El audio se copia para no mover la sincronía.
    """
    escaped = subtitles.resolve().as_posix().replace(":", r"\:").replace("'", r"\'")
    style = "FontName=Arial,FontSize=22,Outline=1"
    stream = ffmpeg.output(
        ffmpeg.input(str(video)),
        str(dest),
        vf=f"subtitles='{escaped}':charenc=UTF-8:force_style='{style}'",
        vcodec="h264_nvenc",
        acodec="copy",
        preset="p4",
        pix_fmt="yuv420p",
        **{"rc": "vbr", "cq": "23", "b:v": "0"},
    )
    _run(stream)
