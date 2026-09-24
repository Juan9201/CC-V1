import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Cue:
    index: int
    start: float
    end: float
    text: str
    lang: str = ""


@dataclass(frozen=True)
class SpokenWord:
    start: float
    end: float
    text: str
    lang: str = ""


_ES = frozenset(
    "el la los las un una unos unas de del al que y o pero si no con por para como más mas muy ya "
    "se lo le les me te nos os su sus es son era eran está esta están estan hay ser ir ver dar hacer "
    "decir porque cuando donde dónde esto esta estos estas ese esa eso aquí aqui allí alli también "
    "tambien ahora bien mal poco mucho todo toda todos todas mi tu yo él ella ellos ellas nosotros "
    "usted ustedes mañana hoy ayer ejemplo significa quiere".split()
)
_EN = frozenset(
    "the a an of to and or but if not with for from as at by in on is are was were be been being "
    "this that these those it he she they we you i my your his her our their now then there here "
    "what when where why how can will just very more most so do does did have has had tomorrow "
    "today yesterday example means".split()
)


def word_language(token: str) -> str:
    """Marca la palabra como español o inglés para poder separarla en dos líneas."""
    if any(ch in token.lower() for ch in "áéíóúñü¿¡"):
        return "es"
    cleaned = token.strip(".,;:!?¿¡\"'()[]").lower()
    if cleaned in _ES and cleaned not in _EN:
        return "es"
    if cleaned in _EN and cleaned not in _ES:
        return "en"
    return ""


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


_TIME = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def _clock(hours: str, minutes: str, seconds: str, millis: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def parse_srt(text: str) -> list[Cue]:
    """
    PROPÓSITO: Recuperar cues desde un SRT ya escrito en disco.
    CONEXIONES: Ninguna. El quemado animado usa estos tiempos, no los reescribe.
    """
    cues: list[Cue] = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = [line.strip("\ufeff") for line in block.splitlines() if line.strip()]
        match = None
        time_index = 0
        for index, line in enumerate(lines):
            match = _TIME.search(line)
            if match is not None:
                time_index = index
                break
        if match is None:
            continue
        start = _clock(*match.group(1, 2, 3, 4))
        end = _clock(*match.group(5, 6, 7, 8))
        body = " ".join(lines[time_index + 1 :]).strip()
        if not body or end <= start:
            continue
        cues.append(Cue(index=len(cues) + 1, start=start, end=end, text=body))
    return cues


def replace_text(cues: list[Cue], texts: list[str]) -> list[Cue]:
    """Sustituye solo el texto. Los tiempos de cada cue se quedan igual."""
    if len(cues) != len(texts):
        raise ValueError(f"DeepSeek devolvió {len(texts)} textos para {len(cues)} cues")
    return [
        Cue(index=cue.index, start=cue.start, end=cue.end, text=text.strip(), lang=cue.lang)
        for cue, text in zip(cues, texts, strict=True)
    ]


def group_words(
    words: list[SpokenWord],
    max_chars: int = 84,
    max_duration: float = 6.0,
) -> list[Cue]:
    """
    PROPÓSITO: Armar cues en el borde de una frase o de un cambio de idioma.
    CONEXIONES: Los tiempos son los de la primera y la última palabra del grupo.
    """
    cues: list[Cue] = []
    bucket: list[SpokenWord] = []

    def flush() -> None:
        if not bucket:
            return
        text = " ".join(word.text for word in bucket).strip()
        known = [word.lang for word in bucket if word.lang]
        lang = max(set(known), key=known.count) if known else ""
        cues.append(
            Cue(
                index=len(cues) + 1,
                start=bucket[0].start,
                end=bucket[-1].end,
                text=text,
                lang=lang,
            )
        )
        bucket.clear()

    for word in words:
        cleaned = word.text.strip()
        if not cleaned:
            continue
        spoken = SpokenWord(word.start, word.end, cleaned, word.lang or word_language(cleaned))
        if bucket:
            previous = next((item.lang for item in reversed(bucket) if item.lang), "")
            tentative = f"{' '.join(item.text for item in bucket)} {cleaned}"
            duration = spoken.end - bucket[0].start
            language_break = bool(previous and spoken.lang and previous != spoken.lang)
            if language_break or len(tentative) > max_chars or duration > max_duration:
                flush()
        bucket.append(spoken)
        if cleaned[-1] in ".?!":
            flush()
    flush()
    return cues
