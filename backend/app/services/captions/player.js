function presentWords(text) {
  let open = false;
  const out = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (/^[,.]+$/.test(token) && out.length > 0) {
      out[out.length - 1] += token;
      continue;
    }
    let word = token;
    let tail = "";
    const glued = word.match(/^(.*?)([,.]+)$/);
    if (glued && glued[1]) {
      word = glued[1];
      tail = glued[2];
    }
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
    out.push((upper ? word.toLocaleUpperCase("es-ES") : word) + tail);
  }
  return out;
}

function buildCue(spec) {
  const stage = document.getElementById("stage");
  stage.replaceChildren();
  const line = document.createElement("div");
  line.className = "line";
  line.style.color = spec.textColor;
  line.style.fontSize = spec.fontPx + "px";
  const shown = presentWords(spec.text).join(" ");
  const pieces = spec.preset === "typewriter" ? Array.from(shown) : shown.split(/\s+/).filter(Boolean);
  const tokens = pieces.map((piece) => {
    const el = document.createElement("span");
    el.className = "token";
    el.textContent = piece;
    return el;
  });
  tokens.forEach((el, index) => {
    if (index > 0 && spec.preset !== "typewriter") {
      line.appendChild(document.createTextNode(" "));
    }
    line.appendChild(el);
  });
  stage.appendChild(line);

  const tl = gsap.timeline({ paused: true });
  const outroStart = Math.max(0, spec.duration - spec.outro);
  if (spec.preset === "typewriter") {
    const count = Math.max(tokens.length, 1);
    const stagger = spec.typeWindow / count;
    tl.from(
      tokens,
      { opacity: 0, duration: Math.min(0.08, stagger || 0.08), stagger, ease: "none" },
      0,
    );
  } else if (spec.preset === "highlight") {
    tl.from(line, { y: 12, opacity: 0, duration: spec.intro, ease: "power3.out" }, 0);
    spec.marks.forEach((mark, index) => {
      const el = tokens[index];
      if (!el) {
        return;
      }
      tl.to(el, { color: spec.highlightColor, duration: mark.fade }, mark.start);
      tl.to(el, { color: spec.textColor, duration: mark.fade }, mark.start + mark.fade + mark.stay);
    });
  } else {
    const stagger = Math.min(0.04, spec.intro / Math.max(tokens.length, 1));
    tl.from(line, { y: 12, opacity: 0, duration: spec.intro, ease: "power3.out" }, 0);
    tl.from(tokens, { scale: 0.92, duration: spec.intro, stagger, ease: "power3.out" }, 0);
  }
  if (spec.outro > 0 && outroStart < spec.duration) {
    tl.to(line, { opacity: 0, duration: spec.outro, ease: "power1.in" }, outroStart);
  }
  window.__tl = tl;
}

window.loadCue = async (spec) => {
  gsap.ticker.lagSmoothing(0);
  buildCue(spec);
  await document.fonts.load(spec.fontPx + "px Caption");
  await document.fonts.ready;
  window.__tl.time(0, false);
};

window.seek = (time) => {
  const timeline = window.__tl;
  const next = Math.max(0, Math.min(time, timeline.duration()));
  timeline.time(next, false);
  return next;
};
