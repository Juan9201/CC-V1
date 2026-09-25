import queue
import threading
from pathlib import Path

from app.services import whisper_engine
from app.services.pipeline import process_file
from app.storage.jobs import job_store


class GpuWorker:
    """
    PROPÓSITO: Procesar un video cada vez en el hilo que posee el modelo CUDA.
    CONEXIONES: Cola en memoria, FFmpeg, faster-whisper, DeepSeek.
    """

    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[str, list[tuple[str, Path]]]] = queue.Queue()
        self._thread = threading.Thread(target=self._loop, name="gpu-worker", daemon=True)
        self._model: object | None = None
        self._active: str | None = None
        self._file_id: str | None = None
        self._queued: list[str] = []
        self._lock = threading.Lock()
        self._thread.start()

    def note_file(self, job_id: str, file_id: str) -> None:
        with self._lock:
            if self._active == job_id:
                self._file_id = file_id

    def status(self) -> dict[str, object]:
        with self._lock:
            active_id = self._active
            file_id = self._file_id
            queued_ids = list(self._queued)
        return {
            "active": _file_view(active_id, file_id),
            "queued": [view for job_id in queued_ids if (view := _file_view(job_id, None)) is not None],
        }

    def submit(self, job_id: str, files: list[tuple[str, Path]]) -> None:
        with self._lock:
            ahead = self._queue.qsize() + (1 if self._active else 0)
            self._queued.append(job_id)
        self._queue.put((job_id, files))
        if ahead:
            job_store.append_log(
                job_id,
                "worker",
                f"Encolado. Hay {ahead} lote(s) delante, el worker todavía no lo toma.",
                "warn",
            )
        else:
            job_store.append_log(job_id, "worker", "Encolado. El worker está libre y lo toma ahora.")

    def _loop(self) -> None:
        while True:
            job_id, files = self._queue.get()
            with self._lock:
                self._active = job_id
                self._file_id = None
                if job_id in self._queued:
                    self._queued.remove(job_id)
            try:
                job_store.append_log(job_id, "worker", f"Worker tomó el lote ({len(files)} archivo)")
                if self._model is None:
                    job_store.append_log(job_id, "whisper", "Cargando el modelo medium en la GPU")
                    from faster_whisper import WhisperModel

                    self._model = WhisperModel("medium", device="cuda", compute_type="float16")
                    whisper_engine.bind_model(self._model)
                    job_store.append_log(job_id, "whisper", "Modelo listo")
                for file_id, path in files:
                    self.note_file(job_id, file_id)
                    current = job_store.get(job_id)
                    skipped = False
                    if current is not None:
                        for item in current.items:
                            if item.file_id == file_id and item.cancelled:
                                skipped = True
                    if skipped:
                        job_store.append_log(job_id, "worker", f"Killer ya sacó {path.name} de la cola", "warn")
                        continue
                    job_store.append_log(job_id, "worker", f"Empieza {path.name}")
                    process_file(job_id, file_id, path)
                job_store.append_log(job_id, "worker", "El worker soltó este lote")
            except Exception as exc:
                job_store.append_log(job_id, "worker", str(exc), "error")
                job = job_store.get(job_id)
                if job is not None:
                    for item in job.items:
                        if item.status == "queued":
                            job_store.update_item(
                                job_id,
                                item.file_id,
                                status="error",
                                error=str(exc),
                                detail="El worker de GPU se detuvo",
                            )
            finally:
                with self._lock:
                    self._active = None
                    self._file_id = None
                self._queue.task_done()


def _file_view(job_id: str | None, file_id: str | None) -> dict[str, object] | None:
    if not job_id:
        return None
    job = job_store.get(job_id)
    if job is None or not job.items:
        return None
    item = next((row for row in job.items if row.file_id == file_id), None)
    if item is None:
        item = next((row for row in job.items if row.status not in {"done", "error"}), job.items[0])
    return {
        "job_id": job_id,
        "file_id": item.file_id,
        "filename": item.filename,
        "status": item.status,
        "reviewing": item.status.startswith("review_"),
    }


gpu_worker = GpuWorker()
