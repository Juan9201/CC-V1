"""Junta Whisper, la alineación del texto final y la boca en una sola lista de tiempos."""

from app.schemas.job import WordTick
from app.services.align_audio import spoken_token
from app.services.lip_sync import MouthTrack
from app.services.srt_io import Cue

_SNAP = 0.12


def _normalize(text: str) -> str:
    return spoken_token(text)


def _inside(words: list[WordTick], start: float, end: float) -> list[WordTick]:
    return [word for word in words if word.end > start + 0.02 and word.start < end - 0.02]


def _from_whisper(cue: Cue, shown: list[str], whisper: list[WordTick]) -> list[WordTick]:
    heard = _inside(whisper, cue.start - 0.35, cue.end + 0.35)
    if not heard:
        return []
    pool = list(heard)
    ticks: list[WordTick] = []
    for token in shown:
        key = _normalize(token)
        match = next((word for word in pool if _normalize(word.text) == key), None)
        if match is None:
            return []
        pool.remove(match)
        ticks.append(WordTick(start=match.start, end=match.end, text=token, lang="es"))
    return ticks


def _equal(cue: Cue, shown: list[str], lang: str) -> list[WordTick]:
    if not shown:
        return []
    span = max(0.04, cue.end - cue.start)
    each = span / len(shown)
    return [
        WordTick(start=cue.start + index * each, end=cue.start + (index + 1) * each, text=token, lang=lang)
        for index, token in enumerate(shown)
    ]


def _clamp_pair(start: float, end: float, floor: float, ceiling: float) -> tuple[float, float]:
    start = min(max(start, floor), ceiling - 0.04)
    end = min(max(end, start + 0.04), ceiling)
    return start, end


def _snap(ticks: list[WordTick], mouth: MouthTrack, floor: float, ceiling: float) -> list[WordTick]:
    if not mouth.opens and not mouth.closes:
        return ticks
    snapped: list[WordTick] = []
    previous_end = floor
    for index, tick in enumerate(ticks):
        following = ticks[index + 1].start if index + 1 < len(ticks) else ceiling
        start = tick.start + mouth.offset
        end = tick.end + mouth.offset
        open_at = min(mouth.opens, key=lambda moment: abs(moment - start), default=None)
        close_at = min(mouth.closes, key=lambda moment: abs(moment - end), default=None)
        if open_at is not None and abs(open_at - start) <= _SNAP:
            start = open_at
        if close_at is not None and abs(close_at - end) <= _SNAP:
            end = close_at
        start = max(start, previous_end)
        end = min(end, following)
        start, end = _clamp_pair(start, end, floor, ceiling)
        if snapped:
            start = max(start, snapped[-1].end)
            start, end = _clamp_pair(start, end, floor, ceiling)
        snapped.append(WordTick(start=start, end=end, text=tick.text, lang=tick.lang))
        previous_end = snapped[-1].end
    return snapped


def _inherit(spoken: list[WordTick], cue: Cue, shown: list[str]) -> list[WordTick]:
    if not shown:
        return []
    if not spoken:
        return _equal(cue, shown, "en")
    if len(spoken) == len(shown):
        return [
            WordTick(start=word.start, end=word.end, text=token, lang="en")
            for word, token in zip(spoken, shown)
        ]
    weights = [max(0.04, word.end - word.start) for word in spoken]
    total = sum(weights)
    cuts = [spoken[0].start]
    cursor = spoken[0].start
    for weight in weights:
        cursor += weight
        cuts.append(cursor)
    span = cuts[-1] - cuts[0]
    ticks: list[WordTick] = []
    for index, token in enumerate(shown):
        left = cuts[0] + span * index / len(shown)
        right = cuts[0] + span * (index + 1) / len(shown)
        ticks.append(WordTick(start=left, end=max(left + 0.04, right), text=token, lang="en"))
    return ticks


def fuse(
    spanish: list[Cue],
    english: list[Cue],
    whisper: list[WordTick],
    aligned: list[list[WordTick]],
    mouth: MouthTrack,
) -> tuple[list[WordTick], list[WordTick]]:
    """
    PROPÓSITO: Una palabra del texto quemado, un tiempo. El inglés copia el ritmo de lo hablado.
    CONEXIONES: La alineación manda. Si falla, Whisper. Si tampoco hay palabras, rebanadas iguales.
    """
    spanish_ticks: list[WordTick] = []
    for index, cue in enumerate(spanish):
        shown = [token for token in cue.text.split() if spoken_token(token)]
        chosen = aligned[index] if index < len(aligned) and len(aligned[index]) == len(shown) else []
        if not chosen:
            chosen = _from_whisper(cue, shown, whisper)
        if not chosen:
            chosen = _equal(cue, shown, "es")
        spanish_ticks.extend(_snap(chosen, mouth, cue.start, max(cue.end, cue.start + 0.04)))
    english_ticks: list[WordTick] = []
    for cue in english:
        shown = [token for token in cue.text.split() if spoken_token(token)]
        heard = _inside(spanish_ticks, cue.start, cue.end)
        english_ticks.extend(_inherit(heard, cue, shown))
    return spanish_ticks, english_ticks
