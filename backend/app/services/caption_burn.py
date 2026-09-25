import base64
import shutil
import struct
import subprocess
from pathlib import Path

import ffmpeg

from app.schemas.job import CaptionStyle, WordTick
from app.services.caption_style import resolve_font
from app.services.ffmpeg_silence import (
    ffmpeg_executable,
    ffprobe_executable,
    probe_durations,
    video_frame_rate,
)
from app.services.srt_io import Cue, parse_srt

_ASSETS = Path(__file__).resolve().parent / "captions"
_SIZE_PX = {"sm": 36, "md": 52, "lg": 68}
_MAX_FPS = 30


def burn_srt(
    video: Path,
    subtitles: Path,
    dest: Path,
    style: CaptionStyle,
    work_dir: Path,
    words: list[WordTick] | None = None,
    force_lang: str = "",
) -> None:
    """
    PROPÓSITO: Incrustar un SRT con la plantilla GSAP elegida para el lote.
    CONEXIONES: Playwright captura la franja. FFmpeg la superpone con h264_nvenc y copia el audio.
    """
    cues = parse_srt(subtitles.read_text(encoding="utf-8"))
    if not cues:
        raise RuntimeError("El SRT no tiene frases para animar")
    _burn(video, cues, dest, style, work_dir, words or [], force_lang)


def burn_bilingual(
    video: Path,
    subtitles: Path,
    dest: Path,
    style: CaptionStyle,
    work_dir: Path,
    words: list[WordTick],
    timing_es: list[WordTick] | None = None,
    timing_en: list[WordTick] | None = None,
) -> None:
    """
    PROPÓSITO: Quemar el ejemplo en inglés arriba y la explicación en español abajo.
    CONEXIONES: Dos franjas sobre el mismo video. Los tiempos siguen siendo los del SRT.
    """
    cues = parse_srt(subtitles.read_text(encoding="utf-8"))
    if not cues:
        raise RuntimeError("El SRT no tiene frases para animar")
    english = [cue for cue in cues if _cue_lang(cue, words) == "en"]
    spanish = [cue for cue in cues if _cue_lang(cue, words) != "en"]
    if not english or not spanish:
        _burn(video, cues, dest, style, work_dir, timing_es or words, "es")
        return
    width, height = _video_size(video)
    duration = probe_durations(video).get("video") or probe_durations(video)["format"]
    font_px = max(18, round(_SIZE_PX[style.size] * (height / 1080)))
    strip_h = _strip_height(height, font_px)
    en_overlay = _render_overlay(video, english, style, work_dir / "en", timing_en or words, "en")
    es_overlay = _render_overlay(video, spanish, style, work_dir / "es", timing_es or words, "es")
    y_es = _overlay_y(style.position, height, strip_h)
    y_en = max(0, y_es - strip_h - 8)
    _composite_two(video, en_overlay, es_overlay, dest, y_en, y_es, duration)
    en_overlay.unlink(missing_ok=True)
    es_overlay.unlink(missing_ok=True)


def _cue_lang(cue: Cue, words: list[WordTick]) -> str:
    inside = [word.lang for word in words if word.lang and word.end > cue.start and word.start < cue.end]
    if not inside:
        return ""
    return max(set(inside), key=inside.count)


def _burn(
    video: Path,
    cues: list[Cue],
    dest: Path,
    style: CaptionStyle,
    work_dir: Path,
    words: list[WordTick],
    force_lang: str = "",
) -> None:
    overlay = _render_overlay(video, cues, style, work_dir, words, force_lang)
    width, height = _video_size(video)
    font_px = max(18, round(_SIZE_PX[style.size] * (height / 1080)))
    duration = probe_durations(video).get("video") or probe_durations(video)["format"]
    _composite(video, overlay, dest, _overlay_y(style.position, height, _strip_height(height, font_px)), duration)
    overlay.unlink(missing_ok=True)


def _caption_colors(style: CaptionStyle, lang: str) -> tuple[str, str]:
    if style.preset == "highlight" and style.lang_colors:
        if lang == "en":
            return style.en_text_color, style.en_highlight_color
        return style.es_text_color, style.es_highlight_color
    return style.text_color, style.highlight_color


def _render_overlay(
    video: Path,
    cues: list[Cue],
    style: CaptionStyle,
    work_dir: Path,
    words: list[WordTick],
    force_lang: str = "",
) -> Path:
    width, height = _video_size(video)
    fps_num, fps_den = _overlay_rate(*video_frame_rate(video))
    frame_dt = fps_den / fps_num
    duration = probe_durations(video).get("video") or probe_durations(video)["format"]
    font_px = max(18, round(_SIZE_PX[style.size] * (height / 1080)))
    strip_h = _strip_height(height, font_px)
    work_dir.mkdir(parents=True, exist_ok=True)
    frames = work_dir / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)
    blank = frames / "blank.png"
    _write_blank(blank, width, strip_h)

    placed = _place_cues(cues, duration)
    if not placed:
        raise RuntimeError("Ningún subtítulo cae dentro de la duración del video")

    font_path, font_format = resolve_font(style.font)
    html = (_ASSETS / "stage.html").read_text(encoding="utf-8")
    html = html.replace("__WIDTH__", str(width)).replace("__HEIGHT__", str(strip_h))
    font_css = (
        "@font-face{font-family:Caption;font-weight:700;font-style:normal;"
        f"src:url(data:font/{font_format};base64,{base64.b64encode(font_path.read_bytes()).decode()}) "
        f"format('{font_format}');}}"
    )
    player = (_ASSETS / "player.js").read_text(encoding="utf-8")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Falta Playwright. En el venv de esta rama: playwright install chromium") from exc

    timeline: list[tuple[Path, float]] = []
    cursor = 0.0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": strip_h}, device_scale_factor=1)
            page.set_content(html, wait_until="domcontentloaded")
            page.add_style_tag(content=font_css)
            page.add_script_tag(path=str(_ASSETS / "gsap.min.js"))
            page.add_script_tag(content=player)
            for cue_index, (start, end, text) in enumerate(placed):
                if start > cursor + 1e-4:
                    timeline.append((blank, start - cursor))
                lang = force_lang or _cue_lang(Cue(index=cue_index, start=start, end=end, text=text), words)
                spec, samples = _cue_plan(style.preset, text, end - start, frame_dt, font_px, style, words, start, lang)
                page.evaluate("(spec) => window.loadCue(spec)", spec)
                for sample_index, (seek, span) in enumerate(samples):
                    page.evaluate("(time) => window.seek(time)", seek)
                    shot = frames / f"c{cue_index:04d}_{sample_index:04d}.png"
                    page.screenshot(path=str(shot), omit_background=True, type="png")
                    _expect_size(shot, width, strip_h)
                    timeline.append((shot, span))
                cursor = end
        finally:
            browser.close()

    if duration - cursor > 1e-3:
        timeline.append((blank, duration - cursor))
    overlay = work_dir / "overlay.mov"
    _encode_overlay(timeline, overlay, frames)
    shutil.rmtree(frames, ignore_errors=True)
    return overlay


def _video_size(path: Path) -> tuple[int, int]:
    probe = ffmpeg.probe(str(path), cmd=ffprobe_executable())
    for stream in probe["streams"]:
        if stream.get("codec_type") != "video":
            continue
        width = int(stream["width"])
        height = int(stream["height"])
        return width - (width % 2), height - (height % 2)
    raise RuntimeError("El video no tiene pista de imagen")


def _overlay_rate(num: int, den: int) -> tuple[int, int]:
    if num <= 0 or den <= 0:
        return 30, 1
    if num / den > _MAX_FPS:
        return _MAX_FPS, 1
    return num, den


def _strip_height(video_height: int, font_px: int) -> int:
    raw = font_px + 36
    raw = min(raw, video_height)
    if raw % 2:
        raw -= 1
    return max(2, raw)


def _overlay_y(position: str, video_height: int, strip_h: int) -> int:
    if position == "center":
        y = (video_height - strip_h) // 2
    else:
        safe = round(video_height * 0.06)
        y = video_height - strip_h - safe
    y -= y % 2
    return max(0, min(y, video_height - strip_h))


def _place_cues(cues: list[Cue], duration: float) -> list[tuple[float, float, str]]:
    placed: list[tuple[float, float, str]] = []
    cursor = 0.0
    for cue in cues:
        text = " ".join(cue.text.split())
        start = max(cue.start, cursor)
        end = min(cue.end, duration)
        if not text or end - start < 0.04:
            continue
        placed.append((start, end, text))
        cursor = end
    return placed


def _heard_marks(
    tokens: list[str],
    duration: float,
    intro: float,
    cue_start: float,
    spoken: list[WordTick],
    lang: str = "",
) -> list[dict[str, float]]:
    """El resalte dura lo que dura la palabra oída, no una rebanada igual del cue."""
    cue_end = cue_start + duration
    pool = spoken
    if lang == "en":
        tagged = [word for word in spoken if word.lang == "en"]
        if tagged:
            pool = tagged
    elif lang == "es":
        tagged = [word for word in spoken if word.lang != "en"]
        if tagged:
            pool = tagged
    inside = [word for word in pool if word.end > cue_start + 0.02 and word.start < cue_end - 0.02]
    if not tokens:
        return []
    if not inside or abs(len(inside) - len(tokens)) > max(1, len(tokens) // 3):
        each = duration / len(tokens)
        return [
            {"start": index * each, "fade": 0.0, "stay": each}
            for index in range(len(tokens))
        ]
    marks: list[dict[str, float]] = []
    for word in inside[: len(tokens)]:
        local = max(0.0, word.start - cue_start)
        stay = max(0.04, min(word.end, cue_end) - max(word.start, cue_start))
        marks.append({"start": local, "fade": 0.0, "stay": stay})
    return marks


def _cue_plan(
    preset: str,
    text: str,
    duration: float,
    frame_dt: float,
    font_px: int,
    style: CaptionStyle,
    spoken: list[WordTick] | None = None,
    cue_start: float = 0.0,
    lang: str = "",
) -> tuple[dict[str, object], list[tuple[float, float]]]:
    intro, outro = _motion_spans(duration, frame_dt)
    tokens = text.split() or [text]
    marks: list[dict[str, float]] = []
    type_window = intro
    if preset == "highlight":
        marks = _heard_marks(tokens, duration, intro, cue_start, spoken or [], lang)
    elif preset == "typewriter":
        type_window = max(intro, (duration - outro) * 0.45)

    spec: dict[str, object] = {
        "preset": preset,
        "text": text,
        "duration": duration,
        "intro": intro,
        "outro": outro,
        "typeWindow": type_window,
        "textColor": _caption_colors(style, lang or "es")[0],
        "highlightColor": _caption_colors(style, lang or "es")[1],
        "fontPx": font_px,
        "marks": marks,
    }
    if preset == "typewriter":
        samples = _window_samples(duration, frame_dt, type_window, outro)
    elif preset == "highlight":
        samples = _highlight_samples(duration, frame_dt, intro, outro, marks)
    else:
        samples = _window_samples(duration, frame_dt, intro, outro)
    return spec, _fit(samples, duration)


def _motion_spans(duration: float, frame_dt: float) -> tuple[float, float]:
    del duration, frame_dt
    return 0.0, 0.0


def _window_samples(duration: float, frame_dt: float, head: float, outro: float) -> list[tuple[float, float]]:
    if head <= 0 and outro <= 0:
        return [(0.0, duration)]
    samples: list[tuple[float, float]] = []
    head_n = max(1, round(head / frame_dt)) if head > 0 else 0
    outro_n = max(1, round(outro / frame_dt)) if outro > 0 else 0
    head_span = head_n * frame_dt
    outro_span = outro_n * frame_dt
    for index in range(head_n):
        samples.append((index * frame_dt, frame_dt))
    hold = duration - head_span - outro_span
    if hold > 1e-4:
        samples.append((head_span, hold))
    outro_at = duration - outro_span
    for index in range(outro_n):
        samples.append((outro_at + index * frame_dt, frame_dt))
    return samples


def _highlight_samples(
    duration: float,
    frame_dt: float,
    intro: float,
    outro: float,
    marks: list[dict[str, float]],
) -> list[tuple[float, float]]:
    """El fotograma se muestra en el tiempo de la palabra, no al acabar la anterior."""
    del intro, outro
    samples: list[tuple[float, float]] = []
    cursor = 0.0
    ordered = sorted(marks, key=lambda mark: float(mark["start"]))
    for index, mark in enumerate(ordered):
        at = min(duration, max(0.0, float(mark["start"])))
        if index + 1 < len(ordered):
            off = min(duration, max(at, float(ordered[index + 1]["start"])))
        else:
            off = min(duration, max(at, at + float(mark["stay"])))
        if at > cursor + 1e-4:
            samples.append((min(cursor, duration), at - cursor))
        if off > at + 1e-4:
            samples.append((min(duration, at + frame_dt * 0.5), off - at))
        cursor = max(cursor, off)
    if duration - cursor > 1e-4:
        samples.append((min(cursor, duration), duration - cursor))
    return samples or [(0.0, duration)]


def _fit(samples: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    if duration <= 0:
        return [(0.0, 0.04)]
    if not samples:
        return [(0.0, duration)]
    total = sum(span for _, span in samples)
    seek, span = samples[-1]
    span += duration - total
    if span <= 0:
        fitted: list[tuple[float, float]] = []
        for sample_at, sample_span in samples:
            if sample_at >= duration - 1e-4:
                break
            room = duration - sample_at
            if room <= 1e-4:
                continue
            fitted.append((sample_at, min(sample_span, room)))
        if not fitted:
            return [(0.0, duration)]
        last_at, last_span = fitted[-1]
        if last_at + last_span < duration - 1e-4:
            fitted[-1] = (last_at, duration - last_at)
        return fitted
    fitted = list(samples[:-1])
    fitted.append((seek, span))
    return fitted


def _write_blank(dest: Path, width: int, height: int) -> None:
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={width}x{height}:r=1:d=1,format=rgba,colorchannelmixer=aa=0",
            "-frames:v",
            "1",
            str(dest),
        ],
        capture_output=True,
    )
    if completed.returncode != 0 or not dest.is_file():
        detail = completed.stderr.decode("utf-8", errors="replace")[-800:]
        raise RuntimeError(detail or "No se pudo crear el fotograma transparente")
    _expect_size(dest, width, height)


def _expect_size(path: Path, width: int, height: int) -> None:
    with path.open("rb") as handle:
        handle.seek(16)
        found_w, found_h = struct.unpack(">II", handle.read(8))
    if (found_w, found_h) != (width, height):
        raise RuntimeError(f"El fotograma mide {found_w}x{found_h} y el video espera {width}x{height}")


def _encode_overlay(timeline: list[tuple[Path, float]], dest: Path, frames: Path) -> None:
    script = frames / "overlay.ffconcat"
    lines = ["ffconcat version 1.0"]
    for path, span in timeline:
        if span <= 0:
            continue
        lines.append(f"file '{path.name}'")
        lines.append(f"duration {span:.6f}")
    lines.append(f"file '{timeline[-1][0].name}'")
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            script.name,
            "-vf",
            "format=rgba",
            "-c:v",
            "qtrle",
            str(dest.resolve()),
        ],
        cwd=frames,
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace")[-1800:]
        raise RuntimeError(detail or "No se pudo armar la pista de subtítulos")


def _composite(video: Path, overlay: Path, dest: Path, y: int, duration: float) -> None:
    # ffmpeg-python añade -map por cada entrada y deja el video limpio como primera pista.
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-y",
            "-i",
            str(video),
            "-i",
            str(overlay),
            "-filter_complex",
            f"[1:v]format=rgba[cap];[0:v][cap]overlay=x=(W-w)/2:y={y}:format=auto:eof_action=pass[v]",
            "-map",
            "[v]",
            "-map",
            "0:a:0",
            "-t",
            f"{duration:.6f}",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-rc",
            "vbr",
            "-cq",
            "23",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace")[-1800:]
        if "minimum required Nvidia driver" in detail:
            raise RuntimeError(
                "h264_nvenc no abrió. Este FFmpeg exige el driver NVIDIA 610 o más nuevo "
                "y el instalado expone NVENC API 13.0."
            )
        raise RuntimeError(detail or "No se pudo superponer los subtítulos")


def _composite_two(
    video: Path,
    top: Path,
    bottom: Path,
    dest: Path,
    y_top: int,
    y_bottom: int,
    duration: float,
) -> None:
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-y",
            "-i",
            str(video),
            "-i",
            str(top),
            "-i",
            str(bottom),
            "-filter_complex",
            (
                f"[1:v]format=rgba[top];[2:v]format=rgba[bottom];"
                f"[0:v][top]overlay=x=(W-w)/2:y={y_top}:format=auto:eof_action=pass[mid];"
                f"[mid][bottom]overlay=x=(W-w)/2:y={y_bottom}:format=auto:eof_action=pass[v]"
            ),
            "-map",
            "[v]",
            "-map",
            "0:a:0",
            "-t",
            f"{duration:.6f}",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-rc",
            "vbr",
            "-cq",
            "23",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace")[-1800:]
        raise RuntimeError(detail or "No se pudo superponer las dos líneas")
