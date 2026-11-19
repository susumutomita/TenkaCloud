// The semantic record and controls never depend on canvas support.
// API reference: developer.chrome.com/docs/web-platform/html-in-canvas/2d
(() => {
  const story = document.querySelector(".incident-story");
  if (!(story instanceof HTMLElement)) return;
  const root = story;
  /** @param {string} selector */
  function element(selector) {
    const node = root.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing incident element: ${selector}`);
    return node;
  }
  /** @param {string} selector */
  function elements(selector) {
    return [...root.querySelectorAll(selector)].filter((node) => node instanceof HTMLElement);
  }
  const canvas = element("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  /** @type {HTMLCanvasElement & { requestPaint?: () => void }} */
  const surface = canvas;
  const controls = element(".incident-controls");
  const chapters = [...elements("[data-step]")];
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let phase = 0;
  let scrollChapter = 0;
  let person = "own";
  let visible = false;
  let frame = 0;
  let progress = 0;
  /** @typedef {CanvasRenderingContext2D & { drawElementImage: (element: HTMLElement, ...coordinates: number[]) => void }} DrawableContext */
  /** @type {DrawableContext | null} */
  let context = null;
  /** @type {HTMLElement | null} */
  let source = null;
  let failed = false;
  let disposed = false;
  let distortionStart = 0;
  /** @type {Animation | null} */
  let distortionAnimation = null;

  function renderState() {
    root.dataset.phase = String(phase);
    root.dataset.person = person;
    const own = person === "own";
    const id = own ? "1042" : "1043";
    const denied = phase === 2 && !own;
    const result = denied ? "fixed" : own ? "own" : "leak";
    element("[data-request-id]").textContent = id;
    element("[data-record-id]").textContent = denied ? "—" : `ID ${id}`;
    element("[data-http]").textContent = denied ? "403 Forbidden" : "200 OK";
    element("[data-record-own]").hidden = !own;
    element("[data-record-other]").hidden = own || denied;
    element("[data-record-denied]").hidden = !denied;
    elements("[data-result]").forEach((el) => {
      el.hidden = el.dataset.result !== result;
    });
    elements("[data-person-select]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.personSelect === person));
    });
    updateSource(denied);
    beginDistortion();
    schedulePaint();
  }

  function stopDistortion() {
    distortionStart = 0;
    distortionAnimation?.cancel();
    distortionAnimation = null;
  }

  function beginDistortion() {
    stopDistortion();
    if (!visible || document.hidden || motion.matches) return;
    distortionStart = performance.now();
    const layer = element(".incident-world");
    // The reference's flowing entry/exit becomes a short wave in the data layer.
    // DOM text, responses and controls are outside this layer and remain readable.
    if (typeof layer.animate === "function") {
      distortionAnimation = layer.animate(
        [
          { transform: "translate(0, 0) skewY(0deg)" },
          { transform: "translate(-10px, 6px) skewY(-3deg)", offset: 0.42 },
          { transform: "translate(0, 0) skewY(0deg)" },
        ],
        { duration: 760, easing: "cubic-bezier(.22, 1, .36, 1)" },
      );
    }
  }

  /** @param {boolean} denied */
  function updateSource(denied) {
    // A noninteractive HTML paint root. No private data, external images or requests.
    if (!source) return;
    source.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = denied
      ? "403 / BOUNDARY"
      : person === "own"
        ? "1042 / Aoi Example"
        : "1043 / Ren Example";
    const detail = document.createElement("span");
    detail.textContent = denied
      ? "ownerId ≠ session.userId"
      : person === "own"
        ? "aoi@example.invalid"
        : "ren@example.invalid";
    source.append(heading, detail);
  }

  /** @param {number} next */
  function usePhase(next) {
    phase = next;
    person = next === 0 ? "own" : "other";
    renderState();
  }

  function onScroll() {
    if (!visible) return;
    // Deterministic in both directions; button state persists until the next chapter.
    const target = window.innerHeight * 0.65;
    let next = 0;
    chapters.forEach((chapter, index) => {
      if (chapter.getBoundingClientRect().top < target) next = index;
    });
    if (next !== scrollChapter) {
      scrollChapter = next;
      usePhase(next);
    }
    const box = root.getBoundingClientRect();
    progress = Math.max(0, Math.min(1, -box.top / Math.max(1, box.height - window.innerHeight)));
    schedulePaint();
  }

  function fallback() {
    failed = true;
    root.dataset.renderer = "dom";
    canvas.style.opacity = "0";
    if (context) context.clearRect(0, 0, surface.width, surface.height);
  }

  /** @param {number} width @param {number} height */
  function resizeSurface(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2, 1400 / width, 1000 / height);
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (surface.width !== w || surface.height !== h) {
      surface.width = w;
      surface.height = h;
    }
    return dpr;
  }

  /** @param {DrawableContext} ctx @param {HTMLElement} node @param {number} elapsed */
  function drawEcho(ctx, node, elapsed) {
    if (motion.matches || elapsed >= 1) {
      ctx.drawElementImage(node, 0, 0);
      return;
    }
    const strength = Math.sin(elapsed * Math.PI) * 30;
    const slice = (node.offsetHeight || 72) / 18;
    // Bounded 2D band displacement: a flowing HTML echo, no WebGPU dependency.
    for (let i = 0; i < 18; i++) {
      const wave = Math.sin(i * 0.48 - elapsed * 7);
      const drift = wave * strength + elapsed * strength;
      ctx.drawElementImage(
        node,
        0,
        i * slice,
        250,
        slice,
        drift,
        i * slice - strength * 0.45,
        250 + strength * 0.6,
        slice + 1,
      );
    }
  }

  /** @param {DrawableContext} ctx @param {number} width @param {number} height */
  function placeEcho(ctx, width, height) {
    const drift = motion.matches ? 0 : progress * 28;
    ctx.save();
    ctx.globalAlpha = phase === 1 ? 0.65 : 0.22;
    ctx.translate(width * 0.12, height * 0.4 + drift);
    ctx.rotate(phase === 1 && !motion.matches ? -0.14 : 0);
  }

  function paint() {
    if (!visible || document.hidden || failed || !context || !source) return;
    try {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const dpr = resizeSurface(width, height);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      placeEcho(context, width, height);
      const elapsed = distortionStart
        ? Math.min(1, (performance.now() - distortionStart) / 760)
        : 1;
      drawEcho(context, source, elapsed);
      context.restore();
      root.dataset.renderer = "canvas";
      if (elapsed < 1) schedulePaint();
    } catch (error) {
      console.warn("Incident visual: HTML-in-Canvas failed; using DOM scene.", error);
      fallback();
    }
  }

  function schedulePaint() {
    if (frame || failed || !context || !visible || document.hidden || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Paint events provide fresh DOM pixels; requestPaint is an optional scheduler.
      if (typeof surface.requestPaint === "function") surface.requestPaint();
      else paint();
    });
  }

  const candidate = /** @type {DrawableContext | null} */ (canvas.getContext("2d"));
  if ("content" in canvas && candidate && typeof candidate.drawElementImage === "function") {
    context = candidate;
    source = document.createElement("div");
    source.setAttribute("drawable", "");
    canvas.append(source);
    canvas.addEventListener("paint", paint, options);
  } else {
    root.dataset.renderer = "dom";
  }
  canvas.setAttribute("aria-hidden", "true");
  controls.hidden = false;
  controls.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (!button) return;
      if (button.hasAttribute("data-reset")) usePhase(0);
      else if (button.hasAttribute("data-fix")) usePhase(2);
      else {
        person = button.dataset.personSelect || "own";
        if (phase === 0 && person === "other") phase = 1;
        renderState();
      }
    },
    options,
  );
  window.addEventListener("scroll", onScroll, { ...options, passive: true });
  window.addEventListener("resize", schedulePaint, options);
  motion.addEventListener(
    "change",
    () => {
      stopDistortion();
      schedulePaint();
    },
    options,
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) stopDistortion();
      schedulePaint();
    },
    options,
  );
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) onScroll();
    else {
      stopDistortion();
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  intersection.observe(element(".incident-stage"));
  const resize = new ResizeObserver(schedulePaint);
  resize.observe(canvas);
  function cleanup() {
    disposed = true;
    stopDistortion();
    abort.abort();
    intersection.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
  }
  // Keep bfcache pages operational when the visitor returns with Back.
  window.addEventListener(
    "pagehide",
    (event) => {
      if (!event.persisted) cleanup();
    },
    options,
  );
  renderState();
})();
