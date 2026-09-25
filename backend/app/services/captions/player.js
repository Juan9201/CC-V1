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
  if (spec.preset === "typewriter") {
    const count = Math.max(tokens.length, 1);
    const stagger = spec.typeWindow / count;
    tl.set(tokens, { opacity: 0 }, 0);
    tokens.forEach((el, index) => {
      tl.set(el, { opacity: 1 }, index * stagger);
    });
  } else if (spec.preset === "highlight") {
    spec.marks.forEach((mark, index) => {
      const el = tokens[index];
      if (!el) {
        return;
      }
      tl.set(el, { color: spec.highlightColor }, mark.start);
      tl.set(el, { color: spec.textColor }, mark.start + mark.stay);
    });
  }
  tl.set(line, { opacity: 1 }, spec.duration);
  window.__tl = tl;
}

window.loadCue = async (spec) => {
  gsap.ticker.lagSmoothing(0);
  buildCue(spec);
  await document.fonts.load(spec.fontPx + "px Caption");
  await document.fonts.ready;
  const line = document.querySelector(".line");
  const stage = document.getElementById("stage");
  const maxWidth = stage.clientWidth * 0.92;
  let size = spec.fontPx;
  while (line && line.scrollWidth > maxWidth && size > 16) {
    size -= 1;
    line.style.fontSize = size + "px";
  }
  window.__tl.time(0, false);
};

window.seek = (time) => {
  const timeline = window.__tl;
  const next = Math.max(0, Math.min(time, timeline.duration()));
  timeline.time(next, false);
  return next;
};
