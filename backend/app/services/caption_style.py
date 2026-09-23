import re
from pathlib import Path

from app.schemas.job import CaptionStyle

_PRESETS = {"pop", "highlight", "typewriter"}
_POSITIONS = {"bottom", "center"}
_SIZES = {"sm", "md", "lg"}
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_FONT_FORMATS = {".woff2": "woff2", ".ttf": "truetype", ".otf": "opentype"}


def fonts_dir() -> Path:
    """Carpeta de fuentes del backend. El nombre del archivo, sin extensión, es el id."""
    return Path(__file__).resolve().parents[2] / "fonts"


def list_font_ids() -> list[str]:
    root = fonts_dir()
    if not root.is_dir():
        return []
    return sorted(
        path.stem
        for path in root.iterdir()
        if path.is_file() and path.suffix.lower() in _FONT_FORMATS
    )


def resolve_font(font_id: str) -> tuple[Path, str]:
    """
    PROPÓSITO: Resolver el archivo de una fuente pedida por la interfaz.
    CONEXIONES: backend/fonts. Rechaza rutas para no leer archivos fuera de esa carpeta.
    """
    if not font_id or Path(font_id).name != font_id:
        raise ValueError("Fuente no válida")
    root = fonts_dir()
    for suffix, css_format in _FONT_FORMATS.items():
        path = root / f"{font_id}{suffix}"
        if path.is_file():
            return path, css_format
    raise ValueError(f"No está la fuente {font_id}")


def parse_caption_style(
    preset: str,
    font: str,
    text_color: str,
    highlight_color: str,
    position: str,
    size: str,
) -> CaptionStyle:
    """
    PROPÓSITO: Validar el estilo que llega con el lote.
    CONEXIONES: El worker lee este objeto al incrustar los subtítulos.
    """
    if preset not in _PRESETS:
        raise ValueError("Plantilla no válida")
    if position not in _POSITIONS:
        raise ValueError("Posición no válida")
    if size not in _SIZES:
        raise ValueError("Tamaño no válido")
    if _COLOR.fullmatch(text_color) is None or _COLOR.fullmatch(highlight_color) is None:
        raise ValueError("El color tiene que ser #RRGGBB")
    resolve_font(font)
    return CaptionStyle(
        preset=preset,  # type: ignore[arg-type]
        font=font,
        text_color=text_color.upper(),
        highlight_color=highlight_color.upper(),
        position=position,  # type: ignore[arg-type]
        size=size,  # type: ignore[arg-type]
    )
