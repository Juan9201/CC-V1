from threading import Event, Lock


class ReviewGate:
    """
    PROPÓSITO: Detener el worker hasta que la interfaz confirme el paso en revisión.
    CONEXIONES: Ninguna. El evento vive en memoria, junto al lote.
    """

    def __init__(self) -> None:
        self._events: dict[tuple[str, str], Event] = {}
        self._lock = Lock()

    def arm(self, job_id: str, file_id: str) -> None:
        with self._lock:
            self._events[(job_id, file_id)] = Event()

    def wait(self, job_id: str, file_id: str) -> None:
        with self._lock:
            event = self._events[(job_id, file_id)]
        event.wait()
        with self._lock:
            self._events.pop((job_id, file_id), None)

    def release(self, job_id: str, file_id: str) -> None:
        with self._lock:
            event = self._events.get((job_id, file_id))
        if event is not None:
            event.set()


review_gate = ReviewGate()
