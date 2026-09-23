from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from app.config import settings
from app.schemas.job import BatchJob
from app.services.caption_style import list_font_ids, parse_caption_style
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
    }


@router.post("", response_model=BatchJob, status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    files: list[UploadFile] = File(...),
    preset: str = Form("pop"),
    font: str = Form("Inter"),
    text_color: str = Form("#FFFFFF"),
    highlight_color: str = Form("#FFE14A"),
    position: str = Form("bottom"),
    size: str = Form("md"),
) -> BatchJob:
    """
    PROPÓSITO: Recibir varios videos y el estilo de subtítulos, y encolarlos en el worker.
    CONEXIONES: Disco local. El corte, Whisper y el quemado ocurren después, de a un archivo.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Sube al menos un video")
    try:
        style = parse_caption_style(preset, font, text_color, highlight_color, position, size)
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

    gpu_worker.submit(job.job_id, staged)
    stored = job_store.get(job.job_id)
    return stored if stored is not None else job


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
