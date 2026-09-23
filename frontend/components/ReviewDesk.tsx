"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type Span = { start: number; end: number };
type CueDraft = { start: number; end: number; text: string; source: string; suggestion: string };

type Style = {
  preset: string;
  font: string;
  text_color: string;
  highlight_color: string;
  position: string;
  size: string;
  track: string;
};

type ReviewItem = {
  file_id: string;
  status: string;
  detail: string;
  cut_revision: number;
  review_language: string;
  downloads: { video: string | null };
  keeps: Span[];
  cues: CueDraft[];
  cues_en: CueDraft[];
};

type BatchJob = {
  job_id: string;
  style: Style;
  items: ReviewItem[];
};

const SIZE_RATIO = { sm: 0.034, md: 0.048, lg: 0.064 } as const;

export function ReviewDesk({
  job,
  item,
  fonts,
  onJob,
}: {
  job: BatchJob;
  item: ReviewItem;
  fonts: string[];
  onJob: (job: BatchJob) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stamp = `${item.file_id}:${item.status}:${item.review_language}:${item.cut_revision}`;
  const [keeps, setKeeps] = useState(item.keeps);
  const [cues, setCues] = useState(item.cues);
  const [cuesEn, setCuesEn] = useState(item.cues_en);
  const [openedKeeps, setOpenedKeeps] = useState(JSON.stringify(item.keeps));
  const [style, setStyle] = useState(job.style);
  const [previewTrack, setPreviewTrack] = useState<"es" | "en">("es");
  const [playhead, setPlayhead] = useState(0);
  const [boxHeight, setBoxHeight] = useState(360);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useRef(item);
  const styleSnapshot = useRef(job.style);
  snapshot.current = item;
  styleSnapshot.current = job.style;
  const cutting = item.status === "review_cut";
  const burning = item.status === "review_burn";
  const editingEnglish = item.review_language === "en" && job.style.track === "both";
  const shown = burning
    ? job.style.track === "both"
      ? previewTrack === "en"
        ? cuesEn
        : cues
      : cues
    : editingEnglish
      ? cuesEn
      : cues;

  useEffect(() => {
    const current = snapshot.current;
    const incoming = styleSnapshot.current;
    setKeeps(current.keeps);
    setCues(current.cues);
    setCuesEn(current.cues_en);
    setOpenedKeeps(JSON.stringify(current.keeps));
    setStyle(incoming);
    setPreviewTrack(current.review_language === "en" || incoming.track === "en" ? "en" : "es");
    setError(null);
  }, [stamp]);

  useEffect(() => {
    const face = new FontFace("ReviewCaption", `url(/api/jobs/fonts/${encodeURIComponent(style.font)})`);
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  }, [style.font]);

  function seek(seconds: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = Math.max(0, seconds);
    setPlayhead(video.currentTime);
  }

  async function proceed(recut: boolean) {
    setBusy(true);
    setError(null);
    const body = {
      keeps,
      cues,
      cues_en: cuesEn,
      recut,
      preset: style.preset,
      font: style.font,
      text_color: style.text_color,
      highlight_color: style.highlight_color,
      position: style.position,
      size: style.size,
    };
    try {
      const saved = await fetch(`/api/jobs/${job.job_id}/files/${item.file_id}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!saved.ok) {
        throw new Error((await saved.json()).detail ?? "No se guardó la revisión");
      }
      const released = await fetch(`/api/jobs/${job.job_id}/files/${item.file_id}/continue`, {
        method: "POST",
      });
      if (!released.ok) {
        throw new Error("No se pudo continuar");
      }
      onJob((await released.json()) as BatchJob);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Error de red");
    } finally {
      setBusy(false);
    }
  }

  const current = shown.find((cue) => playhead >= cue.start && playhead < cue.end) ?? null;

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-zinc-300">{item.detail}</p>
      {item.downloads.video && (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video
            ref={videoRef}
            key={item.downloads.video}
            src={item.downloads.video}
            controls
            className="max-h-[420px] w-full"
            onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => setBoxHeight(event.currentTarget.clientHeight || 360)}
          />
          {burning && current && (
            <CaptionOverlay cue={current} time={playhead} style={style} height={boxHeight} />
          )}
        </div>
      )}

      {cutting ? (
        <SpanEditor
          rows={keeps}
          clock="Estos tiempos son del video original. El reproductor muestra el corte actual."
          onChange={setKeeps}
        />
      ) : (
        <CueEditor
          rows={shown}
          onChange={(next) => {
            if ((burning && previewTrack === "en" && job.style.track === "both") || editingEnglish) {
              setCuesEn(next);
            } else {
              setCues(next);
            }
          }}
          onSeek={seek}
        />
      )}

      {burning && job.style.track === "both" && (
        <div className="flex gap-2 text-sm">
          <button type="button" className={previewTrack === "es" ? "text-emerald-400" : "text-zinc-400"} onClick={() => setPreviewTrack("es")}>
            Español
          </button>
          <button type="button" className={previewTrack === "en" ? "text-emerald-400" : "text-zinc-400"} onClick={() => setPreviewTrack("en")}>
            Inglés
          </button>
        </div>
      )}

      {burning && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Plantilla" value={style.preset} onChange={(preset) => setStyle({ ...style, preset })}>
            <option value="pop">Pop</option>
            <option value="highlight">Resalte</option>
            <option value="typewriter">Máquina de escribir</option>
          </Select>
          <Select label="Fuente" value={style.font} onChange={(font) => setStyle({ ...style, font })}>
            {fonts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Select label="Posición" value={style.position} onChange={(position) => setStyle({ ...style, position })}>
            <option value="bottom">Abajo</option>
            <option value="center">Centro</option>
          </Select>
          <Select label="Tamaño" value={style.size} onChange={(size) => setStyle({ ...style, size })}>
            <option value="sm">Pequeño</option>
            <option value="md">Mediano</option>
            <option value="lg">Grande</option>
          </Select>
          <Color label="Texto" value={style.text_color} onChange={(text_color) => setStyle({ ...style, text_color })} />
          <Color
            label="Resalte"
            value={style.highlight_color}
            onChange={(highlight_color) => setStyle({ ...style, highlight_color })}
          />
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {cutting && (
          <button
            type="button"
            disabled={busy}
            onClick={() => proceed(true)}
            className="rounded-md border border-zinc-600 px-4 py-2 text-sm disabled:opacity-40"
          >
            Volver a cortar
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => proceed(cutting && JSON.stringify(keeps) !== openedKeeps)}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"
        >
          {busy ? "Guardando…" : burning ? "Quemar" : "Continuar"}
        </button>
      </div>
    </div>
  );
}

function CaptionOverlay({
  cue,
  time,
  style,
  height,
}: {
  cue: CueDraft;
  time: number;
  style: Style;
  height: number;
}) {
  const local = Math.max(0, time - cue.start);
  const duration = Math.max(0.2, cue.end - cue.start);
  const words = cue.text.split(/\s+/).filter(Boolean);
  const ratio = SIZE_RATIO[style.size as keyof typeof SIZE_RATIO] ?? SIZE_RATIO.md;
  const intro = Math.min(0.18, duration * 0.3);
  const pop = Math.min(1, local / intro);
  let visible = cue.text;
  if (style.preset === "typewriter") {
    const count = Math.max(1, Math.ceil((Math.min(local, duration * 0.45) / (duration * 0.45)) * cue.text.length));
    visible = cue.text.slice(0, count);
  }
  const highlightAt = words.length ? Math.min(words.length - 1, Math.floor((local / duration) * words.length)) : 0;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 flex justify-center px-6 ${
        style.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-[6%]"
      }`}
      style={{
        opacity: style.preset === "pop" || style.preset === "highlight" ? pop : 1,
        transform: style.position === "center" ? undefined : `translateY(${(1 - pop) * 12}px)`,
      }}
    >
      <p
        className="max-w-[90%] text-center font-semibold leading-tight"
        style={{
          fontFamily: "ReviewCaption, Inter, sans-serif",
          fontSize: Math.max(16, height * ratio),
          color: style.text_color,
        }}
      >
        {style.preset === "highlight"
          ? words.map((word, index) => (
              <span key={`${word}-${index}`} style={{ color: index === highlightAt ? style.highlight_color : style.text_color }}>
                {index > 0 ? " " : ""}
                {word}
              </span>
            ))
          : visible}
      </p>
    </div>
  );
}

function SpanEditor({
  rows,
  clock,
  onChange,
}: {
  rows: Span[];
  clock: string;
  onChange: (rows: Span[]) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">{clock}</p>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-6 text-emerald-400">{index + 1}</span>
          <Time value={row.start} onChange={(start) => onChange(rows.map((item, i) => (i === index ? { ...item, start } : item)))} />
          <Time value={row.end} onChange={(end) => onChange(rows.map((item, i) => (i === index ? { ...item, end } : item)))} />
          <button
            type="button"
            className="text-zinc-500"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Quitar
          </button>
        </div>
      ))}
    </div>
  );
}

function CueEditor({
  rows,
  onChange,
  onSeek,
}: {
  rows: CueDraft[];
  onChange: (rows: CueDraft[]) => void;
  onSeek: (seconds: number) => void;
}) {
  return (
    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
      {rows.map((row, index) => (
        <div key={index} className="rounded-md border border-zinc-800 p-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className="text-emerald-400" onClick={() => onSeek(row.start)}>
              {index + 1}
            </button>
            <Time value={row.start} onChange={(start) => patch(rows, index, { start }, onChange)} />
            <Time value={row.end} onChange={(end) => patch(rows, index, { end }, onChange)} />
            <button type="button" className="text-zinc-500" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              Quitar
            </button>
          </div>
          {row.source && row.source !== row.text && <p className="mt-1 text-xs text-zinc-500">{row.source}</p>}
          <textarea
            value={row.text}
            onChange={(event) => patch(rows, index, { text: event.target.value }, onChange)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
            rows={2}
          />
        </div>
      ))}
    </div>
  );
}

function patch(rows: CueDraft[], index: number, change: Partial<CueDraft>, onChange: (rows: CueDraft[]) => void) {
  onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
}

function Time({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      step={0.1}
      value={Number(value.toFixed(2))}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-24 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1"
    />
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="text-sm text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
      >
        {children}
      </select>
    </label>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="text-sm text-zinc-400">
      {label}
      <input
        type="color"
        value={normalizeColor(value)}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-10 w-full rounded-md border border-zinc-700 bg-zinc-950"
      />
    </label>
  );
}

function normalizeColor(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff";
}
