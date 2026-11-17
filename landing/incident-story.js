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
    schedulePaint();
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

  /** @param {DrawableContext} ctx @param {HTMLElement} node */
  function drawEcho(ctx, node) {
    // Readable record stays in DOM; only its visual echo is fragmented.
    if (phase === 1 && !motion.matches) {
      for (let i = 0; i < 5; i++) {
        ctx.drawElementImage(node, 0, i * 12, 250, 12, i * -12, i * 24, 250, 12);
      }
    } else {
      ctx.drawElementImage(node, 0, 0);
    }
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
      const drift = motion.matches ? 0 : progress * 28;
      context.save();
      context.globalAlpha = phase === 1 ? 0.65 : 0.22;
      context.translate(width * 0.12, height * 0.4 + drift);
      context.rotate(phase === 1 && !motion.matches ? -0.14 : 0);
      drawEcho(context, source);
      context.restore();
      root.dataset.renderer = "canvas";
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
  motion.addEventListener("change", schedulePaint, options);
  document.addEventListener("visibilitychange", schedulePaint, options);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) onScroll();
    else {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  intersection.observe(element(".incident-stage"));
  const resize = new ResizeObserver(schedulePaint);
  resize.observe(canvas);
  function cleanup() {
    disposed = true;
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
