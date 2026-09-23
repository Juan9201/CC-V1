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
  cues: { start: number; end: number; text: string; source: string; suggestion: string }[];
  cues_en: { start: number; end: number; text: string; source: string; suggestion: string }[];
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
  };
  items: VideoItem[];
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
  const [position, setPosition] = useState("bottom");
  const [size, setSize] = useState("md");
  const [track, setTrack] = useState("both");
  const [localLogs, setLocalLogs] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const pollWarn = useRef("");
  const [logsWidth, setLogsWidth] = useState(384);
  const [workerWatch, setWorkerWatch] = useState<WorkerWatch>({ active: null, queued: [] });
  const [supervision, setSupervision] = useState(false);
  const jobId = job?.job_id ?? null;
  const jobStatus = job?.status ?? null;

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
      const response = await fetch("/api/jobs/worker");
      if (!response.ok) {
        return;
      }
      setWorkerWatch((await response.json()) as WorkerWatch);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

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
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) {
        const note = `${jobId}:${response.status}`;
        if (pollWarn.current !== note) {
          pollWarn.current = note;
          pushLog("warn", "ui", `Consulta del lote falló: HTTP ${response.status}`);
        }
        return;
      }
      const next = (await response.json()) as BatchJob;
      setJob(next);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

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
  const lastWarn = engineLogs.findLastIndex((line) => line.level === "warn");

  async function actWorker(action: "continue" | "kill") {
    const target = action === "continue" ? workerWatch.active : killTarget;
    const response = await fetch(`/api/jobs/worker/${action}`, { method: "POST" });
    const payload = (await response.json().catch(() => null)) as { detail?: string; filename?: string } | null;
    if (!response.ok) {
      pushLog("error", "ui", payload?.detail ?? `No se pudo ${action}`);
      return;
    }
    pushLog(
      action === "kill" ? "warn" : "info",
      "ui",
      action === "kill"
        ? `Killer elimina de la cola: ${payload?.filename ?? target?.filename ?? "el video"}`
        : `Continue continúa: ${payload?.filename ?? target?.filename ?? "el video"}`,
    );
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
            onChange={(event) => setPreset(event.target.value)}
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
            onChange={(event) => setFont(event.target.value)}
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
            onChange={(event) => setTextColor(event.target.value)}
            className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950"
          />
        </label>
        <label className="text-sm text-zinc-400">
          Color del resalte
          <input
            type="color"
            value={highlightColor}
            onChange={(event) => setHighlightColor(event.target.value)}
            className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950"
          />
        </label>
        <label className="text-sm text-zinc-400">
          Posición
          <select
            value={position}
            onChange={(event) => setPosition(event.target.value)}
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
            onChange={(event) => setSize(event.target.value)}
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
            <p className={line.level === "error" ? "text-red-400" : line.level === "warn" ? "text-amber-300" : "text-zinc-300"}>
              <span className="text-zinc-600">{formatClock(line.at)}</span>{" "}
              <span className="text-emerald-500">{line.source}</span> {line.message}
            </p>
            {index === lastWarn && (workerWatch.active || killTarget) && (
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
    </aside>
    </div>
  );
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
