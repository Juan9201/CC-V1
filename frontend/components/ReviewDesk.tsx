"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type Span = { start: number; end: number };
type WordTick = { start: number; end: number; text: string; lang: "" | "es" | "en" };
type CueDraft = { start: number; end: number; text: string; source: string; suggestion: string; lang?: "" | "es" | "en" };

type Style = {
  preset: string;
  font: string;
  text_color: string;
  highlight_color: string;
  position: string;
  size: string;
  track: string;
  caption_preview?: boolean;
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
  words?: WordTick[];
};

type BatchJob = {
  job_id: string;
  style: Style;
  items: ReviewItem[];
};

const SIZE_RATIO = { sm: 0.034, md: 0.048, lg: 0.064 } as const;
const UNDO_LIMIT = 5;

type Draft = {
  keeps: Span[];
  cues: CueDraft[];
  cuesEn: CueDraft[];
  style: Style;
};

function cloneDraft(draft: Draft): Draft {
  return structuredClone(draft);
}

function changedIndex<T>(previous: T[], next: T[]) {
  const count = Math.max(previous.length, next.length);
  for (let index = 0; index < count; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) {
      return index;
    }
  }
  return 0;
}

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
  const [undoLeft, setUndoLeft] = useState(0);
  const snapshot = useRef(item);
  const styleSnapshot = useRef(job.style);
  const present = useRef<Draft>(cloneDraft({ keeps: item.keeps, cues: item.cues, cuesEn: item.cues_en, style: job.style }));
  const past = useRef<Draft[]>([]);
  const gesture = useRef<{ id: string; at: number } | null>(null);
  const undoRef = useRef(() => {});
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
    present.current = cloneDraft({
      keeps: current.keeps,
      cues: current.cues,
      cuesEn: current.cues_en,
      style: incoming,
    });
    past.current = [];
    gesture.current = null;
    setUndoLeft(0);
  }, [stamp]);

  function publish(next: Draft) {
    present.current = next;
    setKeeps(next.keeps);
    setCues(next.cues);
    setCuesEn(next.cuesEn);
    setStyle(next.style);
  }

  function applyDraft(next: Draft, gestureId: string, coalesceMs: number) {
    if (JSON.stringify(present.current) === JSON.stringify(next)) {
      return;
    }
    const now = performance.now();
    const hot = coalesceMs > 0 && gesture.current?.id === gestureId && now - gesture.current.at < coalesceMs;
    if (!hot) {
      past.current = [...past.current, cloneDraft(present.current)].slice(-UNDO_LIMIT);
      setUndoLeft(past.current.length);
    }
    gesture.current = { id: gestureId, at: now };
    publish(cloneDraft(next));
  }

  function undo() {
    const previous = past.current.pop();
    if (!previous) {
      return;
    }
    gesture.current = null;
    publish(previous);
    setUndoLeft(past.current.length);
  }

  undoRef.current = undo;

  function editKeeps(next: Span[]) {
    const dropped = next.length < present.current.keeps.length;
    const index = changedIndex(present.current.keeps, next);
    applyDraft(
      { ...present.current, keeps: next },
      dropped ? `drop-keep-${index}-${past.current.length}` : `keep-${index}`,
      dropped ? 0 : 700,
    );
  }

  function moveSpoken(next: CueDraft[]) {
    const english =
      present.current.cuesEn.length === next.length
        ? present.current.cuesEn.map((row, index) => ({ ...row, start: next[index].start, end: next[index].end }))
        : present.current.cuesEn;
    applyDraft({ ...present.current, cues: next, cuesEn: english }, "word-lane", 800);
  }

  function editCues(next: CueDraft[], english: boolean) {
    const key = english ? "cuesEn" : "cues";
    const previous = present.current[key];
    const dropped = next.length < previous.length;
    const index = changedIndex(previous, next);
    const textOnly =
      !dropped &&
      next.length === previous.length &&
      next[index] !== undefined &&
      previous[index] !== undefined &&
      next[index].text !== previous[index].text &&
      next[index].start === previous[index].start &&
      next[index].end === previous[index].end;
    applyDraft(
      { ...present.current, [key]: next },
      dropped ? `drop-${key}-${index}-${past.current.length}` : `${key}-${index}-${textOnly ? "text" : "time"}`,
      dropped ? 0 : textOnly ? 1500 : 700,
    );
  }

  function editStyle(patch: Partial<Style>) {
    const field = Object.keys(patch)[0] ?? "style";
    applyDraft(
      { ...present.current, style: { ...present.current.style, ...patch } },
      `style-${field}`,
      field.includes("color") ? 600 : 0,
    );
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === " " && !typing && !event.repeat) {
        event.preventDefault();
        const video = videoRef.current;
        if (!video) {
          return;
        }
        if (video.paused) {
          void video.play();
        } else {
          video.pause();
        }
        return;
      }
      if (event.key.toLowerCase() !== "z" || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (past.current.length === 0) {
        return;
      }
      event.preventDefault();
      undoRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const face = new FontFace("ReviewCaption", `url(/api/jobs/fonts/${encodeURIComponent(style.font)})`);
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  }, [style.font]);

  useEffect(() => {
    if (!cutting) {
      return;
    }
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video && !video.paused && !video.ended) {
        setPlayhead(video.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cutting]);

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
      caption_preview: Boolean(style.caption_preview),
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
          {!cutting && style.caption_preview && (
            <BilingualPreview cues={cues} words={item.words ?? []} time={playhead} style={style} height={boxHeight} />
          )}
        </div>
      )}
      {!cutting && (item.words?.length ?? 0) > 0 && (
        <WordLane
          words={item.words ?? []}
          cues={cues}
          playhead={playhead}
          onSeek={seek}
          onChange={moveSpoken}
        />
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">Ctrl+Z deshace un borrado o un cambio. Se recuerdan los últimos 5.</p>
        {!cutting && (
          <button
            type="button"
            onClick={() => editStyle({ caption_preview: !style.caption_preview })}
            className={`rounded-md border px-3 py-1 text-xs ${style.caption_preview ? "border-emerald-500 text-emerald-300" : "border-zinc-600 text-zinc-300"}`}
          >
            {style.caption_preview ? "Letrero visible" : "Letrero oculto"}
          </button>
        )}
        <button
          type="button"
          disabled={undoLeft === 0 || busy}
          onClick={() => undoRef.current()}
          className="rounded-md border border-zinc-600 px-3 py-1 text-xs text-zinc-200 disabled:opacity-40"
        >
          Deshacer{undoLeft > 0 ? ` ${undoLeft}` : ""}
        </button>
      </div>

      {cutting ? (
        <SpanEditor
          rows={keeps}
          playhead={playhead}
          clock="Estos tiempos son del video original. El reproductor muestra el corte actual."
          onChange={editKeeps}
          onSeek={seek}
        />
      ) : (
        <CueEditor
          rows={shown}
          onChange={(next) => editCues(next, (burning && previewTrack === "en" && job.style.track === "both") || editingEnglish)}
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
          <Select label="Plantilla" value={style.preset} onChange={(preset) => editStyle({ preset })}>
            <option value="pop">Pop</option>
            <option value="highlight">Resalte</option>
            <option value="typewriter">Máquina de escribir</option>
          </Select>
          <Select label="Fuente" value={style.font} onChange={(font) => editStyle({ font })}>
            {fonts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Select label="Posición" value={style.position} onChange={(position) => editStyle({ position })}>
            <option value="bottom">Abajo</option>
            <option value="center">Centro</option>
          </Select>
          <Select label="Tamaño" value={style.size} onChange={(size) => editStyle({ size })}>
            <option value="sm">Pequeño</option>
            <option value="md">Mediano</option>
            <option value="lg">Grande</option>
          </Select>
          <Color label="Texto" value={style.text_color} onChange={(text_color) => editStyle({ text_color })} />
          <Color
            label="Resalte"
            value={style.highlight_color}
            onChange={(highlight_color) => editStyle({ highlight_color })}
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

function BilingualPreview({
  cues,
  words,
  time,
  style,
  height,
}: {
  cues: CueDraft[];
  words: WordTick[];
  time: number;
  style: Style;
  height: number;
}) {
  const spanish = cues.find((cue) => cue.lang !== "en" && time >= cue.start && time < cue.end) ?? null;
  const english = cues.find((cue) => cue.lang === "en" && time >= cue.start && time < cue.end) ?? null;
  if (!spanish && !english) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 z-30 flex flex-col items-center gap-1 px-4">
      {english && <CaptionLine cue={english} time={time} words={words} style={style} height={height} />}
      {spanish && <CaptionLine cue={spanish} time={time} words={words} style={style} height={height} />}
    </div>
  );
}

function CaptionLine({
  cue,
  time,
  words,
  style,
  height,
}: {
  cue: CueDraft;
  time: number;
  words: WordTick[];
  style: Style;
  height: number;
}) {
  const tokens = presentWords(cue.text);
  const shown = tokens.join(" ");
  const duration = Math.max(0.2, cue.end - cue.start);
  const local = Math.max(0, time - cue.start);
  const intro = Math.min(0.18, duration * 0.3);
  const pop = Math.min(1, local / Math.max(intro, 0.04));
  const heard = words.filter((word) => word.end > cue.start && word.start < cue.end);
  const highlightAt = heard.findIndex((word) => time >= word.start && time < word.end);
  const ratio = SIZE_RATIO[style.size as keyof typeof SIZE_RATIO] ?? SIZE_RATIO.md;
  const typed =
    style.preset === "typewriter"
      ? shown.slice(0, Math.max(1, Math.ceil((Math.min(local, duration * 0.45) / (duration * 0.45)) * shown.length)))
      : shown;
  const motion =
    style.preset === "pop" || style.preset === "highlight"
      ? { opacity: pop, transform: `translateY(${(1 - pop) * 12}px) scale(${0.92 + pop * 0.08})` }
      : undefined;
  return (
    <p
      className="max-w-[92%] rounded-md bg-black/55 px-3 py-1 text-center font-semibold leading-tight"
      style={{
        fontFamily: "ReviewCaption, Inter, sans-serif",
        fontSize: Math.max(15, height * ratio * 0.72),
        color: style.text_color,
        ...motion,
      }}
    >
      {style.preset === "highlight"
        ? tokens.map((token, index) => (
            <span key={`${token}-${index}`} style={{ color: index === highlightAt ? style.highlight_color : style.text_color }}>
              {index > 0 ? " " : ""}
              {token}
            </span>
          ))
        : typed}
    </p>
  );
}

function presentWords(text: string) {
  let open = false;
  return text.split(/\s+/).filter(Boolean).map((token) => {
    let word = token;
    let upper = open;
    if (word.startsWith("*")) {
      upper = true;
      open = true;
      word = word.replace(/^\*+/, "");
    }
    if (word.endsWith("*")) {
      upper = true;
      open = false;
      word = word.replace(/\*+$/, "");
    }
    return upper ? word.toLocaleUpperCase("es-ES") : word;
  });
}

function WordLane({
  words,
  cues,
  playhead,
  onSeek,
  onChange,
}: {
  words: WordTick[];
  cues: CueDraft[];
  playhead: number;
  onSeek: (seconds: number) => void;
  onChange: (rows: CueDraft[]) => void;
}) {
  const frame = 1 / 30;
  const [pps, setPps] = useState(160);
  const duration = Math.max(words[words.length - 1]?.end ?? 1, ...cues.map((cue) => cue.end));
  const width = Math.max(duration * pps, 320);

  function quantize(time: number) {
    return Math.round(Math.max(0, time) / frame) * frame;
  }

  function magnet(time: number, edge: "start" | "end", lang: string) {
    const framed = quantize(time);
    const pool = words.filter((word) => !lang || !word.lang || word.lang === lang);
    const points = pool.map((word) => (edge === "start" ? word.start : word.end));
    if (points.length === 0) {
      return framed;
    }
    const nearest = points.reduce((best, point) => (Math.abs(point - framed) < Math.abs(best - framed) ? point : best));
    return Math.abs(nearest - framed) <= frame * 2 ? nearest : framed;
  }

  function drag(index: number, edge: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const row = cues[index];
    const origin = edge === "start" ? row.start : row.end;
    const pointer = event.clientX;
    const move = (ev: PointerEvent) => {
      const nextTime = magnet(origin + (ev.clientX - pointer) / pps, edge, row.lang || "");
      const start = edge === "start" ? Math.min(nextTime, row.end - frame) : row.start;
      const end = edge === "end" ? Math.max(nextTime, row.start + frame) : row.end;
      onChange(cues.map((item, itemIndex) => (itemIndex === index ? { ...row, start, end } : item)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function shift(index: number, event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const row = cues[index];
    const pointer = event.clientX;
    const move = (ev: PointerEvent) => {
      const delta = quantize((ev.clientX - pointer) / pps);
      onChange(
        cues.map((item, itemIndex) =>
          itemIndex === index ? { ...row, start: Math.max(0, row.start + delta), end: row.end + delta } : item,
        ),
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function splitAtPlayhead() {
    const cut = quantize(playhead);
    const index = cues.findIndex((cue) => cut > cue.start + frame && cut < cue.end - frame);
    if (index < 0) {
      return;
    }
    const row = cues[index];
    const lang = row.lang || "";
    const inside = words.filter(
      (word) => word.end > row.start && word.start < row.end && (!lang || !word.lang || word.lang === lang),
    );
    const leftWords = inside.filter((word) => (word.start + word.end) / 2 < cut);
    const rightWords = inside.filter((word) => (word.start + word.end) / 2 >= cut);
    const textOf = (group: WordTick[], fallback: string) => (group.length > 0 ? group.map((word) => word.text).join(" ") : fallback);
    const left: CueDraft = { ...row, end: cut, text: textOf(leftWords, row.text) };
    const right: CueDraft = { ...row, start: cut, text: textOf(rightWords, leftWords.length > 0 ? "" : row.text) };
    onChange([...cues.slice(0, index), left, right, ...cues.slice(index + 1)]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">El borde se mueve de fotograma en fotograma. Se pega a una palabra solo si pasas muy cerca.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setPps((value) => Math.max(48, value / 1.5))} className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-200">
            Alejar
          </button>
          <button type="button" onClick={() => setPps((value) => Math.min(640, value * 1.5))} className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-200">
            Acercar
          </button>
          <button type="button" onClick={splitAtPlayhead} className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-200">
            Partir
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md bg-zinc-950" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, (event.clientX - rect.left + event.currentTarget.scrollLeft) / pps));
      }}>
        <div className="relative h-28" style={{ width }}>
          <div className="absolute inset-y-0 bg-emerald-400/80" style={{ left: playhead * pps, width: 2 }} />
          {words.map((word, index) => (
            <span
              key={`${word.start}-${index}`}
              className={`absolute top-1 truncate text-[10px] ${word.lang === "en" ? "text-sky-300" : "text-zinc-400"}`}
              style={{ left: word.start * pps, width: Math.max(12, (word.end - word.start) * pps) }}
            >
              {word.text}
            </span>
          ))}
          {cues.map((cue, index) => (
            <div
              key={`${cue.start}-${index}`}
              className={`absolute flex h-7 items-center rounded px-1 text-[10px] text-zinc-950 ${cue.lang === "en" ? "top-6 bg-sky-400" : "top-16 bg-emerald-400"}`}
              style={{ left: cue.start * pps, width: Math.max(16, (cue.end - cue.start) * pps) }}
            >
              <button type="button" className="h-full w-2 cursor-ew-resize" onPointerDown={(event) => drag(index, "start", event)} onClick={(event) => event.stopPropagation()} />
              <span className="min-w-0 flex-1 cursor-grab truncate" onPointerDown={(event) => shift(index, event)}>
                {cue.text}
              </span>
              <button type="button" className="h-full w-2 cursor-ew-resize" onPointerDown={(event) => drag(index, "end", event)} onClick={(event) => event.stopPropagation()} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CaptionOverlay({
  cue,
  time,
  style,
  height,
  spoken = [],
}: {
  cue: CueDraft;
  time: number;
  style: Style;
  height: number;
  spoken?: WordTick[];
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
  const heard = spoken.filter((word) => word.end > cue.start && word.start < cue.end);
  const highlightAt = heard.findIndex((word) => time >= word.start && time < word.end);
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
  playhead,
  clock,
  onChange,
  onSeek,
}: {
  rows: Span[];
  playhead: number;
  clock: string;
  onChange: (rows: Span[]) => void;
  onSeek: (seconds: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const laid = layoutKeeps(rows);
  const marker = markerAt(laid, playhead);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = rowRef.current;
    if (!scroller || !row) {
      return;
    }
    const next = row.offsetTop - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, next) });
  }, [marker.index]);

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">{clock}</p>
      <div ref={scrollerRef} className="relative max-h-96 overflow-y-auto pr-1">
        {laid.items.map((item) => {
          const active = item.index === marker.index;
          return (
            <div key={item.index}>
              {item.removed > 0.05 && (
                <p className="flex h-[22px] items-center pl-8 text-[11px] text-zinc-600">
                  se quitan {item.removed.toFixed(2)} s
                </p>
              )}
              <div
                ref={active ? rowRef : undefined}
                className="relative"
                style={{ height: item.height }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("input, button")) {
                    return;
                  }
                  onSeek(cutPoint(item));
                }}
              >
                {active && (
                  <div className="pointer-events-none absolute inset-y-0 right-0 left-6 rounded-md bg-emerald-400/15 ring-1 ring-emerald-400/50" />
                )}
                {active && (
                  <svg
                    viewBox="0 0 12 16"
                    className="pointer-events-none absolute top-1/2 left-3 z-20 h-4 w-3 -translate-y-1/2 drop-shadow-[0_0_6px_rgba(52,211,153,0.85)]"
                    aria-hidden
                  >
                    <polygon points="0,0.75 11.25,8 0,15.25" fill="#34d399" />
                  </svg>
                )}
                <div className="absolute inset-x-0 top-1/2 z-10 flex h-9 -translate-y-1/2 items-center gap-2 pl-7 pr-1">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSeek(cutPoint(item))}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm tabular-nums ${
                      active ? "bg-emerald-400/20 text-emerald-300 ring-1 ring-emerald-400/70" : "text-emerald-400 hover:bg-zinc-800"
                    }`}
                  >
                    {item.index + 1}
                  </button>
                  <Time
                    value={item.row.start}
                    onChange={(start) => onChange(rows.map((row, i) => (i === item.index ? { ...row, start } : row)))}
                  />
                  <Time
                    value={item.row.end}
                    onChange={(end) => onChange(rows.map((row, i) => (i === item.index ? { ...row, end } : row)))}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((_, i) => i !== item.index))}
                    className="inline-flex h-8 w-16 shrink-0 items-center justify-center rounded-md text-sm text-zinc-500 hover:bg-zinc-800"
                  >
                    Quitar
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function layoutKeeps(rows: Span[]) {
  const items: { index: number; row: Span; cutStart: number; duration: number; height: number; top: number; removed: number }[] = [];
  let cut = 0;
  let top = 0;
  rows.forEach((row, index) => {
    const duration = Math.max(0, row.end - row.start);
    const previous = index > 0 ? rows[index - 1].end : row.start;
    const removed = index > 0 ? Math.max(0, row.start - previous) : 0;
    if (removed > 0.05) {
      top += 22;
    }
    const height = Math.min(140, Math.max(44, duration * 22));
    items.push({ index, row, cutStart: cut, duration, height, top, removed });
    top += height;
    cut += duration;
  });
  return { items, totalCut: cut };
}

function cutPoint(item: { cutStart: number; duration: number }) {
  const inset = item.duration > 0 ? Math.min(0.05, item.duration / 2) : 0;
  return item.cutStart + inset;
}

function markerAt(laid: ReturnType<typeof layoutKeeps>, playhead: number) {
  const last = laid.items.length - 1;
  for (const item of laid.items) {
    const end = item.cutStart + item.duration;
    if (playhead < end || item.index === last) {
      return { index: item.index };
    }
  }
  return { index: 0 };
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
          <div className="flex h-9 items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => onSeek(row.start)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-emerald-400 tabular-nums hover:bg-zinc-800"
            >
              {index + 1}
            </button>
            <Time value={row.start} onChange={(start) => patch(rows, index, { start }, onChange)} />
            <Time value={row.end} onChange={(end) => patch(rows, index, { end }, onChange)} />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              className="inline-flex h-8 w-16 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800"
            >
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
      className="h-8 w-24 shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2"
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
