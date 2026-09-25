import json

from openai import OpenAI

from app.config import settings
from app.services.srt_io import Cue, replace_text

_CHUNK = 40


def _client() -> OpenAI:
    if not settings.deepseek_api_key:
        raise RuntimeError("Falta DEEPSEEK_API_KEY en el entorno del backend")
    return OpenAI(api_key=settings.deepseek_api_key, base_url=settings.deepseek_base_url)


def _ask_lines(client: OpenAI, system: str, user_intro: str, chunk: list[Cue]) -> list[str] | None:
    payload = [{"index": cue.index, "text": cue.text} for cue in chunk]
    completion = client.chat.completions.create(
        model=settings.deepseek_model,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": (
                    f"{user_intro}\n"
                    f"Devuelve JSON {{\"lines\": [...]}} con exactamente {len(chunk)} textos, "
                    "en el mismo orden. No unas ni partas frases.\n"
                    f"{json.dumps(payload, ensure_ascii=False)}"
                ),
            },
        ],
    )
    raw = completion.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {}
    lines = parsed.get("lines") if isinstance(parsed, dict) else None
    if isinstance(lines, list) and len(lines) == len(chunk):
        return [_plain(line) for line in lines]
    return None


def _plain(line: object) -> str:
    """DeepSeek a veces devuelve {index, text} en vez de la frase. Solo se queda el texto."""
    if isinstance(line, dict):
        return _plain(line.get("text", ""))
    text = str(line).strip()
    if text.startswith("{") and "'text'" in text:
        try:
            import ast

            parsed = ast.literal_eval(text)
        except (ValueError, SyntaxError):
            return text
        if isinstance(parsed, dict) and "text" in parsed:
            return _plain(parsed["text"])
    return text


def _texts_for(cues: list[Cue], system: str, user_intro: str, on_progress=None) -> list[str]:
    """
    PROPÓSITO: Pedir a DeepSeek solo el texto, en el mismo orden que los cues.
    CONEXIONES: API https://api.deepseek.com mediante el SDK de OpenAI.
    """
    client = _client()
    total = max(len(cues), 1)
    done = 0

    def collect(chunk: list[Cue]) -> list[str]:
        nonlocal done
        if len(chunk) > _CHUNK:
            merged: list[str] = []
            for offset in range(0, len(chunk), _CHUNK):
                merged.extend(collect(chunk[offset : offset + _CHUNK]))
            return merged
        lines = _ask_lines(client, system, user_intro, chunk)
        if lines is None:
            lines = _ask_lines(client, system, user_intro, chunk)
        if lines is not None:
            done += len(chunk)
            if on_progress is not None:
                on_progress(min(1.0, done / total))
            return lines
        if len(chunk) == 1:
            done += 1
            if on_progress is not None:
                on_progress(min(1.0, done / total))
            return [chunk[0].text]
        mid = len(chunk) // 2
        return collect(chunk[:mid]) + collect(chunk[mid:])

    return collect(cues)


def correct_spanish(cues: list[Cue], on_progress=None) -> list[Cue]:
    """
    PROPÓSITO: Corregir cada frase en el idioma en que se dijo, sin mover timestamps.
    CONEXIONES: DeepSeek.
    """
    system = (
        "Eres un editor de subtítulos de una clase que mezcla español e inglés. "
        "Cada elemento es una frase ya cortada. "
        "Si la frase está en inglés, corrígela en inglés y no la traduzcas. "
        "Si está en español, corrígela en español y no la traduzcas. "
        "Si mezcla los dos, conserva los dos. "
        "No resumes, no agregas información y no cambias el significado. "
        "Máximo unas dos líneas de unos 42 caracteres."
    )
    return replace_text(
        cues,
        _texts_for(cues, system, "Corrige estas frases y conserva el idioma de cada una.", on_progress),
    )


def translate_english(cues: list[Cue], on_progress=None) -> list[Cue]:
    """
    PROPÓSITO: Pasar al inglés solo lo que está en español. El inglés hablado se queda.
    CONEXIONES: DeepSeek.
    """
    system = (
        "You write an English subtitle track for a class spoken in Spanish and English. "
        "Translate Spanish into natural English. "
        "If a cue is already English, keep that English and only fix spelling or punctuation. "
        "If a cue mixes both languages, translate only the Spanish words and keep the English words. "
        "Do not merge or split cues. "
        "Each cue must stay readable: at most two lines, about 42 characters per line."
    )
    return replace_text(
        cues,
        _texts_for(
            cues,
            system,
            "Produce the English subtitle line for each cue. Keep one line per cue.",
            on_progress,
        ),
    )
