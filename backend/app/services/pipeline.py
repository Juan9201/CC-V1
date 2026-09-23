from pathlib import Path

from app.config import settings
from app.schemas.job import DownloadLinks
from app.services import deepseek_subtitles, ffmpeg_silence, whisper_engine
from app.services.srt_io import render_srt
from app.storage.jobs import job_store


def _safe_name(name: str) -> str:
    cleaned = Path(name).name
    if cleaned != name or ".." in cleaned:
        raise ValueError("Nombre de archivo no válido")
    return cleaned


def process_file(job_id: str, file_id: str, source: Path) -> None:
    """
    PROPÓSITO: Cortar silencios, transcribir el audio resultante y refinar los subtítulos.
    CONEXIONES: FFmpeg, faster-whisper, DeepSeek.
    """
    root = settings.data_dir / "jobs" / job_id / file_id
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    video_out = root / "video.mp4"
    burned_es = root / "video.es.mp4"
    burned_en = root / "video.en.mp4"
    srt_es = root / "subtitles.es.srt"
    srt_en = root / "subtitles.en.srt"
    wav_path = work / "speech.wav"

    def links() -> DownloadLinks:
        base = f"/api/jobs/{job_id}/files/{file_id}"
        return DownloadLinks(
            video=f"{base}/video" if video_out.exists() else None,
            srt_es=f"{base}/srt-es" if srt_es.exists() else None,
            srt_en=f"{base}/srt-en" if srt_en.exists() else None,
            video_es=f"{base}/video-es" if burned_es.exists() else None,
            video_en=f"{base}/video-en" if burned_en.exists() else None,
        )

    def burn_ready() -> str | None:
        note = None
        if srt_es.exists():
            try:
                ffmpeg_silence.burn_subtitles(video_out, srt_es, burned_es)
            except Exception as exc:
                note = f"No se pudo incrustar el subtítulo bilingüe: {exc}"
        if srt_en.exists():
            try:
                ffmpeg_silence.burn_subtitles(video_out, srt_en, burned_en)
            except Exception as exc:
                note = f"No se pudo incrustar el subtítulo en inglés: {exc}"
        return note

    try:
        job_store.update_item(job_id, file_id, status="cutting", detail="Quitando silencios con NVENC")
        ffmpeg_silence.render_without_silence(source, video_out, work)
        job_store.update_item(job_id, file_id, status="transcribing", detail="Alineando palabras en GPU")
        ffmpeg_silence.extract_whisper_wav(video_out, wav_path)
        cues = whisper_engine.transcribe_spanish(wav_path)
        if not cues:
            raise RuntimeError("Whisper no devolvió palabras")
        srt_es.write_text(render_srt(cues), encoding="utf-8")
        job_store.update_item(job_id, file_id, status="refining", detail="Corrigiendo y traduciendo subtítulos")
        spanish = deepseek_subtitles.correct_spanish(cues)
        english = deepseek_subtitles.translate_english(spanish)
        srt_es.write_text(render_srt(spanish), encoding="utf-8")
        srt_en.write_text(render_srt(english), encoding="utf-8")
        job_store.update_item(job_id, file_id, status="refining", detail="Incrustando subtítulos")
        burn_note = burn_ready()
        job_store.set_downloads(job_id, file_id, links())
        if burn_note:
            job_store.update_item(job_id, file_id, detail=burn_note)
    except Exception as exc:
        burn_ready()
        if srt_es.exists():
            job_store.update_item(
                job_id,
                file_id,
                status="error",
                error=str(exc),
                detail="El video y el SRT bilingüe quedaron listos; falló el refinamiento",
                downloads=links(),
            )
        else:
            job_store.update_item(
                job_id,
                file_id,
                status="error",
                error=str(exc),
                detail="Falló este archivo",
            )
    finally:
        if source.exists() and source.parent == work.parent and source.name.startswith("source"):
            source.unlink()
