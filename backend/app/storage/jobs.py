import time
from threading import Lock
from uuid import uuid4

from app.schemas.job import BatchJob, CaptionStyle, DownloadLinks, JobProgress, LogLine, ProgressStep, VideoItem

_ACTIVE = {
    "cutting",
    "transcribing",
    "refining",
    "review_cut",
    "review_cues",
    "review_text",
    "review_burn",
}


class JobStore:
    """
    PROPÓSITO: Guardar el estado del lote para el polling del frontend.
    CONEXIONES: Ninguna. El estado vive en memoria y se pierde al reiniciar el proceso.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, BatchJob] = {}
        self._lock = Lock()

    def create(self, filenames: list[str], style: CaptionStyle) -> BatchJob:
        job = BatchJob(
            job_id=uuid4().hex,
            status="queued",
            style=style,
            items=[
                VideoItem(file_id=uuid4().hex, filename=name, status="queued")
                for name in filenames
            ],
        )
        with self._lock:
            self._jobs[job.job_id] = job
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> BatchJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def update_item(self, job_id: str, file_id: str, **changes: object) -> None:
        with self._lock:
            job = self._jobs[job_id]
            for index, item in enumerate(job.items):
                if item.file_id != file_id:
                    continue
                job.items[index] = item.model_copy(update=changes)
                break
            self._refresh_status(job)

    def append_log(self, job_id: str, source: str, message: str, level: str = "info") -> None:
        line = LogLine(at=int(time.time() * 1000), level=level, source=source, message=message)  # type: ignore[arg-type]
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.logs.append(line)
            if len(job.logs) > 400:
                del job.logs[:-400]

    def set_progress(self, job_id: str, steps: list[tuple[str, str]], key: str, ratio: float, label: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            keys = [step[0] for step in steps]
            index = keys.index(key) if key in keys else 0
            job.progress = JobProgress(
                steps=[ProgressStep(key=name, label=title) for name, title in steps],
                index=index,
                sub_ratio=max(0.0, min(1.0, ratio)),
                sub_label=label,
            )

    def update_style(self, job_id: str, **changes: object) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.style = job.style.model_copy(update=changes)

    def set_downloads(self, job_id: str, file_id: str, downloads: DownloadLinks) -> None:
        self.update_item(
            job_id,
            file_id,
            downloads=downloads,
            status="done",
            detail="Listo",
            error=None,
        )

    def _refresh_status(self, job: BatchJob) -> None:
        """Calcula el estado del lote a partir de cada archivo."""
        if any(item.status in _ACTIVE for item in job.items):
            job.status = next(item.status for item in job.items if item.status in _ACTIVE)
        elif all(item.status == "done" for item in job.items):
            job.status = "done"
        elif all(item.status in {"done", "error"} for item in job.items):
            job.status = "error"
        else:
            job.status = "queued"


job_store = JobStore()
