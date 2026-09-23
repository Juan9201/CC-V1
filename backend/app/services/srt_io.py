from dataclasses import dataclass


@dataclass(frozen=True)
class Cue:
    index: int
    start: float
    end: float
    text: str


def format_timestamp(seconds: float) -> str:
    """Convierte segundos a HH:MM:SS,mmm."""
    millis = max(0, int(round(seconds * 1000)))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def wrap_subtitle(text: str, width: int = 42) -> str:
    """Parte el texto en máximo dos líneas."""
    words = " ".join(text.split()).split(" ")
    if not words:
        return ""
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if len(candidate) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    if len(lines) <= 2:
        return "\n".join(lines)
    midpoint = max(1, len(lines) // 2)
    return " ".join(lines[:midpoint]) + "\n" + " ".join(lines[midpoint:])


def render_srt(cues: list[Cue]) -> str:
    blocks: list[str] = []
    for position, cue in enumerate(cues, start=1):
        blocks.append(
            f"{position}\n"
            f"{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n"
            f"{wrap_subtitle(cue.text)}"
        )
    return "\n\n".join(blocks) + "\n"


def replace_text(cues: list[Cue], texts: list[str]) -> list[Cue]:
    """Sustituye solo el texto. Los tiempos de cada cue se quedan igual."""
    if len(cues) != len(texts):
        raise ValueError(f"DeepSeek devolvió {len(texts)} textos para {len(cues)} cues")
    return [
        Cue(index=cue.index, start=cue.start, end=cue.end, text=text.strip())
        for cue, text in zip(cues, texts, strict=True)
    ]


def group_words(
    words: list[tuple[float, float, str]],
    max_chars: int = 42,
    max_duration: float = 4.0,
) -> list[Cue]:
    """
    PROPÓSITO: Armar cues cuyo inicio y fin son la primera y la última palabra del grupo.
    CONEXIONES: Ninguna. Los tiempos llegan de faster-whisper sobre el WAV ya cortado.
    """
    cues: list[Cue] = []
    bucket: list[tuple[float, float, str]] = []

    def flush() -> None:
        if not bucket:
            return
        text = " ".join(token for _start, _end, token in bucket).strip()
        cues.append(
            Cue(
                index=len(cues) + 1,
                start=bucket[0][0],
                end=bucket[-1][1],
                text=text,
            )
        )
        bucket.clear()

    for start, end, token in words:
        cleaned = token.strip()
        if not cleaned:
            continue
        if bucket:
            tentative = f"{' '.join(item[2] for item in bucket)} {cleaned}"
            duration = end - bucket[0][0]
            if len(tentative) > max_chars or duration > max_duration:
                flush()
        bucket.append((start, end, cleaned))
    flush()
    return cues
