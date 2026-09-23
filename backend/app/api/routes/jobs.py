from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.schemas.job import BatchJob, CueDraft, Span
from app.services.caption_style import list_font_ids, parse_caption_style, resolve_font
from app.services.review_gate import review_gate
from app.services.worker import gpu_worker
from app.storage.jobs import job_store

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

_ALLOWED = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
_FILES = {
    "video": ("video.mp4", "video/mp4"),
    "video-es": ("video.es.mp4", "video/mp4"),
    "video-en": ("video.en.mp4", "video/mp4"),
    "srt-es": ("subtitles.es.srt", "application/x-subrip"),
    "srt-en": ("subtitles.en.srt", "application/x-subrip"),
}


def _safe_name(name: str) -> str:
    cleaned = Path(name).name
    if not cleaned or cleaned != name or ".." in cleaned:
        raise HTTPException(status_code=400, detail="Nombre de archivo no válido")
    return cleaned


@router.get("/caption-options")
async def caption_options() -> dict[str, list[str]]:
    """
    PROPÓSITO: Listar las fuentes y plantillas que la interfaz puede elegir.
    CONEXIONES: Archivos de backend/fonts.
    """
    return {
        "fonts": list_font_ids(),
        "presets": ["pop", "highlight", "typewriter"],
        "positions": ["bottom", "center"],
        "sizes": ["sm", "md", "lg"],
        "tracks": ["both", "es", "en"],
        "modes": ["auto", "review"],
    }


@router.get("/worker")
async def worker_status() -> dict[str, object]:
    """
    PROPÓSITO: Decir qué video tiene el worker y cuáles esperan en la cola.
    CONEXIONES: GpuWorker y JobStore en memoria.
    """
    return gpu_worker.status()


@router.post("/worker/continue")
async def worker_continue() -> dict[str, object]:
    """
    PROPÓSITO: Soltar la revisión del video que tiene parado al worker.
    CONEXIONES: ReviewGate. El pipeline sigue con ese mismo archivo.
    """
    active = gpu_worker.status().get("active")
    if not isinstance(active, dict) or not active.get("reviewing"):
        raise HTTPException(status_code=409, detail="No hay un video detenido en revisión")
    review_gate.release(str(active["job_id"]), str(active["file_id"]))
    job_store.append_log(str(active["job_id"]), "review", f"Continue: {active['filename']}")
    return active


@router.post("/worker/kill")
async def worker_kill() -> dict[str, object]:
    """
    PROPÓSITO: Sacar de la cola el video que está bloqueando al worker.
    CONEXIONES: Si está en revisión, suelta la espera y el pipeline se detiene.
    """
    report = gpu_worker.status()
    active = report.get("active")
    queued = report.get("queued")
    target = active if isinstance(active, dict) else None
    if target is None and isinstance(queued, list) and queued:
        target = queued[0]
    if not isinstance(target, dict):
        raise HTTPException(status_code=409, detail="La cola está vacía")
    job_store.update_item(
        str(target["job_id"]),
        str(target["file_id"]),
        cancelled=True,
        status="error",
        error="Killer",
        detail="Eliminado de la cola",
    )
    job_store.append_log(str(target["job_id"]), "worker", f"Killer elimina de la cola: {target['filename']}", "warn")
    review_gate.release(str(target["job_id"]), str(target["file_id"]))
    return target


@router.post("", response_model=BatchJob, status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    files: list[UploadFile] = File(...),
    preset: str = Form("pop"),
    font: str = Form("Inter"),
    text_color: str = Form("#FFFFFF"),
    highlight_color: str = Form("#FFE14A"),
    position: str = Form("bottom"),
    size: str = Form("md"),
    track: str = Form("both"),
    mode: str = Form("auto"),
) -> BatchJob:
    """
    PROPÓSITO: Recibir varios videos y el estilo de subtítulos, y encolarlos en el worker.
    CONEXIONES: Disco local. El corte, Whisper y el quemado ocurren después, de a un archivo.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Sube al menos un video")
    try:
        style = parse_caption_style(
            preset, font, text_color, highlight_color, position, size, track, mode
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    names: list[str] = []
    for upload in files:
        filename = _safe_name(upload.filename or "video.mp4")
        if Path(filename).suffix.lower() not in _ALLOWED:
            raise HTTPException(status_code=400, detail=f"Extensión no admitida: {filename}")
        names.append(filename)

    job = job_store.create(names, style)
    staged: list[tuple[str, Path]] = []
    for upload, item in zip(files, job.items, strict=True):
        suffix = Path(item.filename).suffix.lower()
        folder = settings.data_dir / "jobs" / job.job_id / item.file_id
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / f"source{suffix}"
        with dest.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                handle.write(chunk)
        staged.append((item.file_id, dest))

    job_store.append_log(job.job_id, "api", f"Recibidos {len(staged)} video(s). Modo {style.mode}, idioma {style.track}.")
    gpu_worker.submit(job.job_id, staged)
    stored = job_store.get(job.job_id)
    return stored if stored is not None else job


class ReviewBody(BaseModel):
    keeps: list[Span] = Field(default_factory=list)
    cues: list[CueDraft] = Field(default_factory=list)
    cues_en: list[CueDraft] = Field(default_factory=list)
    recut: bool = False
    preset: str | None = None
    font: str | None = None
    text_color: str | None = None
    highlight_color: str | None = None
    position: str | None = None
    size: str | None = None


@router.get("/fonts/{font_id}")
async def font_file(font_id: str) -> FileResponse:
    """
    PROPÓSITO: Servir una fuente de backend/fonts para la previsualización.
    CONEXIONES: El nombre es el stem del archivo, nunca una ruta.
    """
    try:
        path, _css_format = resolve_font(font_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    media = {
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
    }.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media, filename=path.name)


@router.put("/{job_id}/files/{file_id}/review", response_model=BatchJob)
async def save_review(job_id: str, file_id: str, body: ReviewBody) -> BatchJob:
    """
    PROPÓSITO: Guardar cortes, frases y estilo mientras el worker está detenido.
    CONEXIONES: JobStore en memoria. No reanuda el worker.
    """
    job = job_store.get(job_id)
    if job is None or not any(item.file_id == file_id for item in job.items):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    job_store.update_item(
        job_id,
        file_id,
        keeps=body.keeps,
        cues=body.cues,
        cues_en=body.cues_en,
        recut=body.recut,
    )
    style_changes = {
        key: value
        for key, value in {
            "preset": body.preset,
            "font": body.font,
            "text_color": body.text_color,
            "highlight_color": body.highlight_color,
            "position": body.position,
            "size": body.size,
        }.items()
        if value is not None
    }
    if style_changes:
        try:
            merged = job.style.model_copy(update=style_changes)
            parse_caption_style(
                merged.preset,
                merged.font,
                merged.text_color,
                merged.highlight_color,
                merged.position,
                merged.size,
                merged.track,
                merged.mode,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        job_store.update_style(job_id, **style_changes)
    stored = job_store.get(job_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Lote no encontrado")
    return stored


@router.post("/{job_id}/files/{file_id}/continue", response_model=BatchJob)
async def continue_review(job_id: str, file_id: str) -> BatchJob:
    """
    PROPÓSITO: Soltar el worker para el siguiente paso del archivo en revisión.
    CONEXIONES: ReviewGate. El worker ya debe estar esperando.
    """
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Lote no encontrado")
    review_gate.release(job_id, file_id)
    return job


@router.get("/{job_id}", response_model=BatchJob)
async def get_job(job_id: str) -> BatchJob:
    """
    PROPÓSITO: Devolver una copia del estado del lote para el polling.
    CONEXIONES: JobStore en memoria.
    """
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Lote no encontrado")
    return job


@router.get("/{job_id}/files/{file_id}/{kind}")
async def download_output(job_id: str, file_id: str, kind: str) -> FileResponse:
    """
    PROPÓSITO: Servir el MP4 cortado o uno de los dos SRT.
    CONEXIONES: Archivos bajo DATA_DIR. La ruta la arma el servidor.
    """
    spec = _FILES.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail="Tipo de descarga desconocido")
    filename, media_type = spec
    path = (settings.data_dir / "jobs" / job_id / file_id / filename).resolve()
    root = (settings.data_dir / "jobs").resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="El archivo todavía no está listo")
    return FileResponse(path, media_type=media_type, filename=filename)
