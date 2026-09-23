"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";

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
  status: "queued" | "cutting" | "transcribing" | "refining" | "done" | "error";
  detail: string;
  error: string | null;
  downloads: Downloads;
};

type BatchJob = {
  job_id: string;
  status: string;
  items: VideoItem[];
};

const LABELS: Record<VideoItem["status"], string> = {
  queued: "En cola",
  cutting: "Cortando silencios",
  transcribing: "Transcribiendo",
  refining: "Refinando subtítulos",
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
  const jobId = job?.job_id ?? null;
  const jobStatus = job?.status ?? null;

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
        return;
      }
      const next = (await response.json()) as BatchJob;
      setJob(next);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter((file) => file.type.startsWith("video/"));
    setFiles((current) => [...current, ...incoming]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function submit() {
    if (files.length === 0) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("preset", preset);
    body.append("font", font);
    body.append("text_color", textColor);
    body.append("highlight_color", highlightColor);
    body.append("position", position);
    body.append("size", size);
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
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Error de red");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || (jobStatus !== null && jobStatus !== "done" && jobStatus !== "error");

  return (
    <section className="mt-8 space-y-6">
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

      <button
        type="button"
        disabled={files.length === 0 || busy}
        onClick={submit}
        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"
      >
        {busy ? "Procesando…" : "Procesar lote"}
      </button>

      {formError && <p className="text-sm text-red-400">{formError}</p>}

      {job && (
        <ul className="space-y-4">
          {job.items.map((item) => (
            <li key={item.file_id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="font-medium">{item.filename}</p>
                <p className="text-xs uppercase tracking-wide text-zinc-400">{LABELS[item.status]}</p>
              </div>
              <p className="mt-1 text-sm text-zinc-400">{item.detail}</p>
              {item.error && <p className="mt-2 text-sm text-red-400">{item.error}</p>}
              {item.status === "done" || item.downloads.video || item.downloads.srt_es ? (
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
  );
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
