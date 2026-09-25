"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

import { ReviewDesk } from "./ReviewDesk";

type Downloads = {
  video: string | null;
  srt_es: string | null;
  srt_en: string | null;
  video_es: string | null;
  video_en: string | null;
};

type VideoItem = {
  file_id: string;
  filename: string;
  status: string;
  detail: string;
  error: string | null;
  downloads: Downloads;
  keeps: { start: number; end: number }[];
  cues: { start: number; end: number; text: string; source: string; suggestion: string; lang?: string }[];
  cues_en: { start: number; end: number; text: string; source: string; suggestion: string; lang?: string }[];
  words?: { start: number; end: number; text: string; lang: string }[];
  review_language: string;
  recut: boolean;
  cut_revision: number;
};

type LogLine = {
  at: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
};

type WorkerFile = {
  job_id: string;
  file_id: string;
  filename: string;
  status: string;
  reviewing: boolean;
};

type WorkerWatch = {
  active: WorkerFile | null;
  queued: WorkerFile[];
};

type BatchJob = {
  job_id: string;
  status: string;
  logs?: LogLine[];
  style: {
    preset: string;
    font: string;
    text_color: string;
    highlight_color: string;
    position: string;
    size: string;
    track: string;
    caption_preview?: boolean;
    lang_colors?: boolean;
    es_text_color?: string;
    es_highlight_color?: string;
    en_text_color?: string;
    en_highlight_color?: string;
  };
  items: VideoItem[];
  progress?: {
    steps: { key: string; label: string }[];
    index: number;
    sub_ratio: number;
    sub_label: string;
  };
};

const LABELS: Record<string, string> = {
  queued: "En cola",
  cutting: "Cortando silencios",
  transcribing: "Transcribiendo",
  refining: "Refinando subtítulos",
  review_cut: "Revisar corte",
  review_cues: "Revisar transcripción",
  review_text: "Revisar texto",
  review_burn: "Previsualizar",
  done: "Listo",
  error: "Error",
};

export function BatchUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preset, setPreset] = useState("pop");
  const [font, setFont] = useState("Inter");
  const [fonts, setFonts] = useState<string[]>(["Inter"]);
  const [textColor, setTextColor] = useState("#ffffff");
  const [highlightColor, setHighlightColor] = useState("#ffe14a");
  const [langColors, setLangColors] = useState(false);
  const [esTextColor, setEsTextColor] = useState("#ffffff");
  const [esHighlightColor, setEsHighlightColor] = useState("#22c55e");
  const [enTextColor, setEnTextColor] = useState("#38bdf8");
  const [enHighlightColor, setEnHighlightColor] = useState("#e0f2fe");
  const [position, setPosition] = useState("bottom");
  const [size, setSize] = useState("md");
  const [track, setTrack] = useState("both");
  const [localLogs, setLocalLogs] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const pollWarn = useRef("");
  const [logsWidth, setLogsWidth] = useState(384);
  const [workerWatch, setWorkerWatch] = useState<WorkerWatch>({ active: null, queued: [] });
  const [closedConflictAt, setClosedConflictAt] = useState<number | null>(null);
  const acting = useRef(false);
  const liveStyle = useRef<Partial<BatchJob["style"]>>({});
  const [supervision, setSupervision] = useState(false);
  const jobId = job?.job_id ?? null;
  const jobStatus = job?.status ?? null;
  const firstLogAt = job?.logs?.[0]?.at ?? null;
  const [processClock, setProcessClock] = useState<{ id: string; start: number; end: number | null } | null>(null);
  const clockFace = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    setSupervision(window.location.port === "3002");
    const saved = Number(window.localStorage.getItem("cc-logs-width"));
    if (saved >= 220 && saved <= 760) {
      setLogsWidth(saved);
    }
    pushLog("info", "ui", `Página lista en el puerto ${window.location.port}`);
  }, []);

  function resizeLogs(event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = logsWidth;
    const limit = splitRef.current?.getBoundingClientRect().width ?? 1100;
    function move(next: PointerEvent) {
      const width = startWidth - (next.clientX - startX);
      setLogsWidth(Math.min(limit * 0.62, Math.max(220, width)));
    }
    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setLogsWidth((current) => {
        window.localStorage.setItem("cc-logs-width", String(Math.round(current)));
        return current;
      });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function pushLog(level: LogLine["level"], source: string, message: string) {
    setLocalLogs((current) => [...current, { at: Date.now(), level, source, message }].slice(-200));
  }

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/jobs/worker");
        if (!response.ok) {
          return;
        }
        setWorkerWatch((await response.json()) as WorkerWatch);
      } catch {
        // El API no contestó este turno. El siguiente lo vuelve a intentar.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!jobId) {
      return;
    }
    const origin = firstLogAt ?? Date.now();
    setProcessClock((current) => {
      if (current?.id === jobId) {
        if ((jobStatus === "done" || jobStatus === "error") && current.end === null) {
          return { ...current, end: Date.now() };
        }
        return current;
      }
      const finished = jobStatus === "done" || jobStatus === "error";
      return { id: jobId, start: origin, end: finished ? Date.now() : null };
    });
  }, [jobId, jobStatus, firstLogAt]);

  useEffect(() => {
    const face = clockFace.current;
    if (!processClock || !face) {
      return;
    }
    if (processClock.end !== null) {
      face.textContent = formatElapsed(processClock.end - processClock.start);
      return;
    }
    let frame = 0;
    const paint = () => {
      face.textContent = formatElapsed(Date.now() - processClock.start);
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [processClock]);

  useEffect(() => {
    fetch("/api/jobs/caption-options")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { fonts?: string[] } | null) => {
        if (!data?.fonts?.length) {
          return;
        }
        setFonts(data.fonts);
        setFont((current) => (data.fonts?.includes(current) ? current : data.fonts?.[0] ?? current));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!jobId || jobStatus === "done" || jobStatus === "error") {
      return;
    }
    const timer = window.setInterval(async () => {
      let response: Response;
      try {
        response = await fetch(`/api/jobs/${jobId}`);
      } catch {
        return;
      }
      if (!response.ok) {
        const note = `${jobId}:${response.status}`;
        if (pollWarn.current !== note) {
          pollWarn.current = note;
          pushLog("warn", "ui", `Consulta del lote falló: HTTP ${response.status}`);
        }
        return;
      }
      const next = (await response.json()) as BatchJob;
      next.style = { ...next.style, ...liveStyle.current };
      setJob(next);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

  function paintStyle(patch: Partial<BatchJob["style"]>) {
    if (patch.preset) {
      setPreset(patch.preset);
    }
    if (patch.font) {
      setFont(patch.font);
    }
    if (patch.text_color) {
      setTextColor(patch.text_color);
    }
    if (patch.highlight_color) {
      setHighlightColor(patch.highlight_color);
    }
    if (patch.lang_colors !== undefined) {
      setLangColors(patch.lang_colors);
    }
    if (patch.es_text_color) {
      setEsTextColor(patch.es_text_color);
    }
    if (patch.es_highlight_color) {
      setEsHighlightColor(patch.es_highlight_color);
    }
    if (patch.en_text_color) {
      setEnTextColor(patch.en_text_color);
    }
    if (patch.en_highlight_color) {
      setEnHighlightColor(patch.en_highlight_color);
    }
    if (patch.position) {
      setPosition(patch.position);
    }
    if (patch.size) {
      setSize(patch.size);
    }
    liveStyle.current = { ...liveStyle.current, ...patch };
    setJob((current) => (current ? { ...current, style: { ...current.style, ...patch } } : current));
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter((file) => file.type.startsWith("video/"));
    if (incoming.length === 0) {
      pushLog("warn", "ui", "Ningún archivo era un video");
      return;
    }
    setFiles((current) => [...current, ...incoming]);
    pushLog("info", "ui", `Listos para enviar: ${incoming.map((file) => file.name).join(", ")}`);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function submit(mode: "auto" | "review") {
    if (files.length === 0) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    pushLog("info", "ui", `Enviando ${files.length} video(s) en modo ${mode === "review" ? "revisión" : "automático"}`);
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("preset", preset);
    body.append("font", font);
    body.append("text_color", textColor);
    body.append("highlight_color", highlightColor);
    body.append("position", position);
    body.append("size", size);
    body.append("track", track);
    body.append("mode", mode);
    try {
      const response = await fetch("/api/jobs", { method: "POST", body });
      const raw = await response.text();
      let payload: { detail?: string } | null = null;
      try {
        payload = JSON.parse(raw) as { detail?: string };
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null) {
        throw new Error(payload?.detail ?? (raw.slice(0, 180) || `HTTP ${response.status}`));
      }
      setJob(payload as BatchJob);
      setFiles([]);
      pushLog("info", "ui", `El API aceptó el lote ${(payload as BatchJob).job_id.slice(0, 8)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error de red";
      setFormError(message);
      pushLog("error", "ui", message);
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || (jobStatus !== null && jobStatus !== "done" && jobStatus !== "error");
  const engineLogs = [...localLogs, ...(job?.logs ?? [])].sort((left, right) => left.at - right.at);
  const killTarget = workerWatch.active ?? workerWatch.queued[0] ?? null;
  const conflictIndex = engineLogs.findLastIndex((line) => line.level === "warn" && line.message.includes("lote(s) delante"));
  const conflict = conflictIndex >= 0 ? engineLogs[conflictIndex] : null;
  const queueActionsOpen = conflict !== null && conflict.at !== closedConflictAt;

  async function actWorker(action: "continue" | "kill") {
    if (!conflict || conflict.at === closedConflictAt || acting.current) {
      return;
    }
    const closedAt = conflict.at;
    const target = action === "continue" ? workerWatch.active : killTarget;
    acting.current = true;
    setClosedConflictAt(closedAt);
    try {
      const response = await fetch(`/api/jobs/worker/${action}`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { detail?: string; filename?: string } | null;
      if (!response.ok) {
        setClosedConflictAt((current) => (current === closedAt ? null : current));
        pushLog("error", "ui", payload?.detail ?? `No se pudo ${action}`);
        return;
      }
      const filename = payload?.filename ?? target?.filename ?? "el video";
      pushLog("info", "ui", action === "kill" ? `Killer elimina de la cola: ${filename}` : `Continue continúa: ${filename}`);
    } finally {
      acting.current = false;
    }
  }

  useEffect(() => {
    const node = logRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [engineLogs.length]);

  return (
    <div ref={splitRef} className="mt-8 flex flex-col gap-6 lg:flex-row lg:items-stretch lg:gap-0">
    <section className="min-w-0 flex-1 space-y-6">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border border-dashed px-6 py-14 text-center ${
          dragging ? "border-emerald-400 bg-emerald-950/40" : "border-zinc-700 bg-zinc-900"
        }`}
      >
        <p className="text-sm">Arrastra varios videos aquí</p>
        <button
          type="button"
          className="mt-4 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950"
          onClick={() => inputRef.current?.click()}
        >
          Examinar archivos
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              addFiles(event.target.files);
            }
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="space-y-2 text-sm text-zinc-300">
          {files.map((file) => (
            <li key={`${file.name}-${file.size}`}>{file.name}</li>
          ))}
        </ul>
      )}

      <fieldset className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm text-zinc-300">Subtítulos del lote</legend>
        <label className="text-sm text-zinc-400 sm:col-span-2">
          Idioma
          <select
            value={track}
            onChange={(event) => setTrack(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
          >
            <option value="both">Español e inglés</option>
            <option value="es">Solo español</option>
            <option value="en">Solo inglés</option>
          </select>
        </label>
        <label className="text-sm text-zinc-400">
          Plantilla
          <select
            value={preset}
            onChange={(event) => paintStyle({ preset: event.target.value })}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
          >
            <option value="pop">Pop</option>
            <option value="highlight">Resalte</option>
            <option value="typewriter">Máquina de escribir</option>
          </select>
        </label>
        <label className="text-sm text-zinc-400">
          Fuente
          <select
            value={font}
            onChange={(event) => paintStyle({ font: event.target.value })}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
          >
            {fonts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-zinc-400">
          Color del texto
          <input
            type="color"
            value={textColor}
            onChange={(event) => paintStyle({ text_color: event.target.value })}
            className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950"
          />
        </label>
        <label className="text-sm text-zinc-400">
          Color del resalte
          <input
            type="color"
            value={highlightColor}
            onChange={(event) => paintStyle({ highlight_color: event.target.value })}
            className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950"
          />
        </label>
        {preset === "highlight" && (
          <div className="sm:col-span-2 rounded-lg border border-zinc-800 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-zinc-300">Colores por idioma en el pre-quemado</p>
              <button
                type="button"
                onClick={() => paintStyle({ lang_colors: !langColors })}
                className={`rounded-md border px-3 py-1 text-xs ${langColors ? "border-emerald-500 text-emerald-300" : "border-zinc-600 text-zinc-300"}`}
              >
                {langColors ? "ON" : "OFF"}
              </button>
            </div>
            {langColors && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-zinc-800 p-3">
                  <p className="text-sm text-emerald-300">Español</p>
                  <label className="mt-2 block text-sm text-zinc-400">
                    Color del texto
                    <input type="color" value={esTextColor} onChange={(event) => paintStyle({ es_text_color: event.target.value })} className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950" />
                  </label>
                  <label className="mt-2 block text-sm text-zinc-400">
                    Color del resalte
                    <input type="color" value={esHighlightColor} onChange={(event) => paintStyle({ es_highlight_color: event.target.value })} className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950" />
                  </label>
                </div>
                <div className="rounded-md border border-zinc-800 p-3">
                  <p className="text-sm text-sky-300">Inglés</p>
                  <label className="mt-2 block text-sm text-zinc-400">
                    Color del texto
                    <input type="color" value={enTextColor} onChange={(event) => paintStyle({ en_text_color: event.target.value })} className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950" />
                  </label>
                  <label className="mt-2 block text-sm text-zinc-400">
                    Color del resalte
                    <input type="color" value={enHighlightColor} onChange={(event) => paintStyle({ en_highlight_color: event.target.value })} className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950" />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}
        <label className="text-sm text-zinc-400">
          Posición
          <select
            value={position}
            onChange={(event) => paintStyle({ position: event.target.value })}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
          >
            <option value="bottom">Abajo</option>
            <option value="center">Centro</option>
          </select>
        </label>
        <label className="text-sm text-zinc-400">
          Tamaño
          <select
            value={size}
            onChange={(event) => paintStyle({ size: event.target.value })}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
          >
            <option value="sm">Pequeño</option>
            <option value="md">Mediano</option>
            <option value="lg">Grande</option>
          </select>
        </label>
      </fieldset>

      {supervision ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={files.length === 0 || busy}
            onClick={() => submit("auto")}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"
          >
            {busy ? "Procesando…" : "Automático"}
          </button>
          <button
            type="button"
            disabled={files.length === 0 || busy}
            onClick={() => submit("review")}
            className="rounded-md border border-emerald-500 px-4 py-2 text-sm font-medium text-emerald-300 disabled:opacity-40"
          >
            Revisar
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={files.length === 0 || busy}
          onClick={() => submit("auto")}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"
        >
          {busy ? "Procesando…" : "Procesar lote"}
        </button>
      )}

      {formError && <p className="text-sm text-red-400">{formError}</p>}

      {job && (
        <ul className="space-y-4">
          {job.items.map((item) => (
            <li key={item.file_id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="font-medium">{item.filename}</p>
                <p className="text-xs uppercase tracking-wide text-zinc-400">{LABELS[item.status] ?? item.status}</p>
              </div>
              <p className="mt-1 text-sm text-zinc-400">{item.detail}</p>
              {item.error && <p className="mt-2 text-sm text-red-400">{item.error}</p>}
              {supervision && item.status.startsWith("review_") && (
                <ReviewDesk job={job} item={item} fonts={fonts} onJob={(next) => setJob(next as BatchJob)} />
              )}
              {item.status === "done" || (!item.status.startsWith("review_") && (item.downloads.video || item.downloads.srt_es)) ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Download href={item.downloads.video} label="Video limpio" />
                  <Download href={item.downloads.video_es} label="Video con subtítulos" />
                  <Download href={item.downloads.video_en} label="Video en inglés" />
                  <Download href={item.downloads.srt_es} label="Subtítulos bilingües" />
                  <Download href={item.downloads.srt_en} label="Subtítulos EN" />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
    <button
      type="button"
      aria-label="Ancho de los logs"
      onPointerDown={resizeLogs}
      className="group hidden w-3 shrink-0 cursor-col-resize items-stretch justify-center border-0 bg-transparent p-0 lg:flex"
    >
      <span className="w-px bg-zinc-700 transition-colors group-hover:bg-emerald-400" />
    </button>
    <aside
      className="sticky top-6 flex h-[calc(100vh-4.5rem)] w-full max-lg:!w-full shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950"
      style={{ width: logsWidth }}
    >
      <div className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wide text-zinc-400">Logs</div>
      <div ref={logRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
        {engineLogs.length === 0 && <p className="text-zinc-600">Esperando el motor…</p>}
        {engineLogs.map((line, index) => (
          <div key={`${line.at}-${index}`}>
            <p className={line.level === "error" ? "text-red-400" : line.level === "warn" && !isQueueDecision(line.message) ? "text-amber-300" : "text-zinc-300"}>
              <span className="text-zinc-600">{formatClock(line.at)}</span>{" "}
              <span className="text-emerald-500">{line.source}</span> {line.message}
            </p>
            {queueActionsOpen && index === conflictIndex && (
              <div className="mt-2 mb-2 space-y-2 rounded-md border border-amber-400/40 bg-zinc-900 p-2 font-sans">
                <p className="text-[11px] leading-snug text-amber-300">
                  {workerWatch.active?.reviewing
                    ? `Continue continúa: ${workerWatch.active.filename}`
                    : "Continue: no hay un video detenido en revisión"}
                </p>
                <p className="text-[11px] leading-snug text-amber-300">
                  {killTarget ? `Killer elimina de la cola: ${killTarget.filename}` : "Killer: la cola está vacía"}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!workerWatch.active?.reviewing}
                    onClick={() => actWorker("continue")}
                    className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 disabled:opacity-40"
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    disabled={!killTarget}
                    onClick={() => actWorker("kill")}
                    className="rounded-md border border-red-400 px-3 py-1.5 text-xs font-medium text-red-300 disabled:opacity-40"
                  >
                    Killer
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {processClock && (
        <div className="border-t border-zinc-800 px-3 py-3 font-mono">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Tiempo de proceso</p>
          <p ref={clockFace} className="text-2xl text-zinc-100 tabular-nums">{formatElapsed((processClock.end ?? Date.now()) - processClock.start)}</p>
          <p className="text-[11px] text-zinc-400">
            {processClock.end === null ? "En curso" : jobStatus === "error" ? "Detenido" : "Listo para descargar"}
          </p>
          <ProgressBars progress={job?.progress} done={processClock.end !== null && jobStatus !== "error"} />
        </div>
      )}
    </aside>
    </div>
  );
}

function isQueueDecision(message: string) {
  return message.startsWith("Killer elimina") || message.startsWith("Killer eliminó") || message.startsWith("Continue continúa") || message.startsWith("Continue:");
}

function ProgressBars({
  progress,
  done,
}: {
  progress?: BatchJob["progress"];
  done: boolean;
}) {
  const steps = progress?.steps ?? [];
  const count = Math.max(steps.length, 1);
  const sub = done ? 1 : Math.max(0, Math.min(1, progress?.sub_ratio ?? 0));
  const index = done ? count : progress?.index ?? 0;
  const overall = done ? 1 : Math.max(0, Math.min(1, (index + sub) / count));
  const current = steps[Math.min(index, steps.length - 1)];
  return (
    <div className="mt-3 space-y-2 font-sans">
      <div>
        <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide text-zinc-500">
          <span>Proceso general</span>
          <span>{Math.round(overall * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-emerald-400" style={{ width: `${overall * 100}%` }} />
        </div>
        {steps.length > 0 && (
          <p className="mt-1 text-[10px] text-zinc-500">
            {steps.map((step, stepIndex) => (
              <span key={step.key} className={done || stepIndex < index ? "text-emerald-500" : stepIndex === index ? "text-zinc-100" : ""}>
                {stepIndex > 0 ? " · " : ""}
                {step.label}
              </span>
            ))}
          </p>
        )}
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide text-zinc-500">
          <span>{done ? "Listo" : progress?.sub_label || current?.label || "Esperando"}</span>
          <span>{Math.round(sub * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-sky-400" style={{ width: `${sub * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number) {
  const safe = Math.max(0, ms);
  const total = Math.floor(safe / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const millis = Math.floor(safe % 1000);
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return `${clock}.${String(millis).padStart(3, "0")}`;
}

function formatClock(at: number) {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function Download({ href, label }: { href: string | null; label: string }) {
  if (!href) {
    return null;
  }
  return (
    <a href={href} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
      {label}
    </a>
  );
}
