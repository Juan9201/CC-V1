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
        self._thread.start()

    def submit(self, job_id: str, files: list[tuple[str, Path]]) -> None:
        self._queue.put((job_id, files))

    def _loop(self) -> None:
        while True:
            job_id, files = self._queue.get()
            try:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    self._model = WhisperModel("medium", device="cuda", compute_type="float16")
                    whisper_engine.bind_model(self._model)
                for file_id, path in files:
                    process_file(job_id, file_id, path)
            except Exception as exc:
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
                self._queue.task_done()


gpu_worker = GpuWorker()
