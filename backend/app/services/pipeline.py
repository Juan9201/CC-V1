import json
from pathlib import Path

from app.config import settings
from app.schemas.job import CaptionStyle, CueDraft, DownloadLinks, Span, WordTick
from app.services import caption_burn, deepseek_subtitles, ffmpeg_silence, whisper_engine
from app.services.review_gate import review_gate


class JobCancelled(Exception):
    """El operador sacó este video de la cola."""
from app.services.srt_io import Cue, render_srt
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
    stored = job_store.get(job_id)
    style = stored.style if stored is not None else CaptionStyle()
    review = style.mode == "review"
    want_es = style.track in {"es", "both"}
    want_en = style.track in {"en", "both"}

    def current_style() -> CaptionStyle:
        fresh = job_store.get(job_id)
        return fresh.style if fresh is not None else style

    def links(revision: int = 0) -> DownloadLinks:
        base = f"/api/jobs/{job_id}/files/{file_id}"
        version = f"?v={revision}" if revision else ""
        return DownloadLinks(
            video=f"{base}/video{version}" if video_out.exists() else None,
            srt_es=f"{base}/srt-es" if srt_es.exists() else None,
            srt_en=f"{base}/srt-en" if srt_en.exists() else None,
            video_es=f"{base}/video-es" if burned_es.exists() else None,
            video_en=f"{base}/video-en" if burned_en.exists() else None,
        )

    def burn_ready() -> str | None:
        active = current_style()
        note = None
        spoken_now = item_now().words
        if want_es and want_en and srt_es.exists():
            try:
                caption_burn.burn_bilingual(video_out, srt_es, burned_es, active, work / "burn-es", spoken_now)
            except Exception as exc:
                note = f"No se pudo incrustar el subtítulo en español: {exc}"
        elif want_es and srt_es.exists():
            try:
                caption_burn.burn_srt(video_out, srt_es, burned_es, active, work / "burn-es", spoken_now)
            except Exception as exc:
                note = f"No se pudo incrustar el subtítulo en español: {exc}"
        if want_en and srt_en.exists():
            try:
                caption_burn.burn_srt(video_out, srt_en, burned_en, active, work / "burn-en")
            except Exception as exc:
                note = f"No se pudo incrustar el subtítulo en inglés: {exc}"
        return note

    def item_now():
        fresh = job_store.get(job_id)
        if fresh is None:
            raise RuntimeError("El lote desapareció")
        for item in fresh.items:
            if item.file_id == file_id:
                return item
        raise RuntimeError("El archivo desapareció del lote")

    def pause(phase: str, detail: str, **fields: object):
        if not review:
            return
        review_gate.arm(job_id, file_id)
        job_store.append_log(job_id, "review", detail)
        job_store.update_item(
            job_id,
            file_id,
            status=phase,
            detail=detail,
            downloads=links(item_now().cut_revision),
            **fields,
        )
        review_gate.wait(job_id, file_id)
        if item_now().cancelled:
            raise JobCancelled()
        job_store.append_log(job_id, "review", "Continuó")

    def as_cues(drafts: list[CueDraft]) -> list[Cue]:
        rows: list[Cue] = []
        for draft in drafts:
            text = draft.text.strip()
            if text and draft.end > draft.start:
                rows.append(Cue(index=len(rows) + 1, start=draft.start, end=draft.end, text=text))
        if not rows:
            raise RuntimeError("No quedó ninguna frase")
        return rows

    def paired(original: list[Cue], revised: list[Cue]) -> list[CueDraft]:
        rows: list[CueDraft] = []
        for index, cue in enumerate(revised):
            source_text = original[index].text if index < len(original) else ""
            rows.append(
                CueDraft(
                    start=cue.start,
                    end=cue.end,
                    text=cue.text,
                    source=source_text,
                    suggestion=cue.text,
                    lang=cue.lang if cue.lang in {"es", "en"} else "",
                )
            )
        return rows

    try:
        if item_now().cancelled:
            raise JobCancelled()
        keeps: list[tuple[float, float]] | None = None
        while True:
            job_store.update_item(job_id, file_id, status="cutting", detail="Quitando silencios con NVENC")
            job_store.append_log(job_id, "ffmpeg", "Cortando silencios con NVENC")
            ffmpeg_silence.render_without_silence(source, video_out, work, keeps=keeps)
            saved = json.loads((work / "keeps.json").read_text(encoding="utf-8"))
            spans = [Span(start=row["start"], end=row["end"]) for row in saved]
            revision = item_now().cut_revision + 1
            job_store.update_item(job_id, file_id, keeps=spans, recut=False, cut_revision=revision)
            job_store.append_log(job_id, "ffmpeg", f"Corte listo: {len(spans)} tramos")
            if not review:
                break
            pause("review_cut", "Revisa el video cortado. Ajusta los tramos si hace falta.", recut=False)
            edited = item_now()
            if not edited.recut:
                break
            keeps = [(span.start, span.end) for span in edited.keeps]
            job_store.append_log(job_id, "ffmpeg", f"Recorte pedido con {len(keeps)} tramos")

        job_store.update_item(job_id, file_id, status="transcribing", detail="Alineando palabras en GPU")
        job_store.append_log(job_id, "whisper", "Extrayendo audio y transcribiendo")
        ffmpeg_silence.extract_whisper_wav(video_out, wav_path)
        cues, spoken = whisper_engine.transcribe_spanish(wav_path)
        if not cues:
            raise RuntimeError("Whisper no devolvió palabras")
        word_ticks = [
            WordTick(start=word.start, end=word.end, text=word.text, lang=word.lang if word.lang in {"es", "en"} else "")
            for word in spoken
        ]
        job_store.update_item(job_id, file_id, words=word_ticks)
        job_store.append_log(job_id, "whisper", f"Transcripción lista: {len(cues)} frases, {len(spoken)} palabras")
        pause(
            "review_cues",
            "Revisa el texto de Whisper antes de enviarlo a DeepSeek.",
            cues=paired(cues, cues),
            review_language="",
        )
        if review:
            cues = as_cues(item_now().cues)

        if want_es and not want_en:
            detail = "Corrigiendo subtítulos en español"
        elif want_en and not want_es:
            detail = "Traduciendo subtítulos al inglés"
        else:
            detail = "Corrigiendo y traduciendo subtítulos"
        job_store.update_item(job_id, file_id, status="refining", detail=detail)
        job_store.append_log(job_id, "deepseek", detail)
        spanish = deepseek_subtitles.correct_spanish(cues)
        job_store.append_log(job_id, "deepseek", f"Español listo: {len(spanish)} frases")
        if review and want_es:
            pause(
                "review_text",
                "Acepta o corrige el texto en español.",
                cues=paired(cues, spanish),
                review_language="es",
            )
            spanish = as_cues(item_now().cues)
        if want_es:
            srt_es.write_text(render_srt(spanish), encoding="utf-8")
        english: list[Cue] = []
        if want_en:
            job_store.append_log(job_id, "deepseek", "Traduciendo al inglés")
            english = deepseek_subtitles.translate_english(spanish)
            job_store.append_log(job_id, "deepseek", f"Inglés listo: {len(english)} frases")
            if review:
                drafts = paired(spanish, english)
                if want_es:
                    pause(
                        "review_text",
                        "Acepta o corrige el texto en inglés.",
                        cues_en=drafts,
                        review_language="en",
                    )
                    english = as_cues(item_now().cues_en)
                else:
                    pause(
                        "review_text",
                        "Acepta o corrige el texto en inglés.",
                        cues=drafts,
                        review_language="en",
                    )
                    english = as_cues(item_now().cues)
            srt_en.write_text(render_srt(english), encoding="utf-8")

        burn_fields: dict[str, object] = {"review_language": "es" if want_es else "en"}
        if want_es:
            burn_fields["cues"] = paired(spanish, spanish)
        if want_en and want_es:
            burn_fields["cues_en"] = paired(english, english)
        elif want_en:
            burn_fields["cues"] = paired(english, english)
        if review:
            pause("review_burn", "Previsualiza la animación y quema cuando esté bien.", **burn_fields)
            if want_es:
                spanish = as_cues(item_now().cues)
                srt_es.write_text(render_srt(spanish), encoding="utf-8")
            if want_en and want_es:
                english = as_cues(item_now().cues_en)
                srt_en.write_text(render_srt(english), encoding="utf-8")
            elif want_en:
                english = as_cues(item_now().cues)
                srt_en.write_text(render_srt(english), encoding="utf-8")

        job_store.update_item(job_id, file_id, status="refining", detail="Incrustando subtítulos animados")
        job_store.append_log(job_id, "ffmpeg", "Quemando subtítulos animados")
        burn_note = burn_ready()
        job_store.append_log(job_id, "ffmpeg", burn_note or "Quemado listo", "warn" if burn_note else "info")
        job_store.set_downloads(job_id, file_id, links(item_now().cut_revision))
        if burn_note:
            job_store.update_item(job_id, file_id, detail=burn_note)
    except JobCancelled:
        job_store.append_log(job_id, "worker", "Killer eliminó este video de la cola", "warn")
        return
    except Exception as exc:
        job_store.append_log(job_id, "pipeline", str(exc), "error")
        burn_ready()
        ready = []
        if want_es and srt_es.exists():
            ready.append("español")
        if want_en and srt_en.exists():
            ready.append("inglés")
        if ready:
            job_store.update_item(
                job_id,
                file_id,
                status="error",
                error=str(exc),
                detail=f"El video y el SRT en {' y '.join(ready)} quedaron listos; falló el refinamiento",
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
