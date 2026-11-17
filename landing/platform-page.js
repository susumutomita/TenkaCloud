// Native details preserve keyboard access, find-in-page and fragment navigation.
// Print all preserved operational details, then restore the reader's choices.
(() => {
  /** @type {Array<[HTMLDetailsElement, boolean]>} */
  let printState = [];
  window.addEventListener("beforeprint", () => {
    if (printState.length) return;
    printState = [...document.querySelectorAll("details")].map((item) => [item, item.open]);
    for (const [item] of printState) item.open = true;
  });
  window.addEventListener("afterprint", () => {
    for (const [item, open] of printState) item.open = open;
    printState = [];
  });
})();

// The scene uses the existing product previews; headings and CTAs stay outside it.
(() => {
  const sceneRoot = document.querySelector(".platform-scene");
  if (!(sceneRoot instanceof HTMLElement)) return;
  const root = sceneRoot;
  const hero = root.closest(".hero");
  const panels = [...root.querySelectorAll("[data-scene-panel]")].filter(
    (node) => node instanceof HTMLElement,
  );
  const buttons = [...root.querySelectorAll("[data-scene-select]")].filter(
    (node) => node instanceof HTMLButtonElement,
  );
  const controls = root.querySelector(".platform-scene-controls");
  const canvas = root.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement) || !(controls instanceof HTMLElement)) return;
  const surface = /** @type {HTMLCanvasElement & {requestPaint?: () => void}} */ (canvas);
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();
  const options = { signal: abort.signal };
  /** @typedef {CanvasRenderingContext2D & {drawElementImage: (node: HTMLElement, x: number, y: number) => void}} SceneContext */
  /** @type {SceneContext | null} */
  let context = null;
  /** @type {HTMLElement | null} */
  let source = null;
  /** @type {Animation | null} */
  let animation = null;
  let frame = 0;
  let began = 0;
  let visible = true;
  let failed = false;
  let current = 0;

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    began = 0;
    animation?.cancel();
    animation = null;
    surface.style.opacity = "0";
  }
  function fallback() {
    failed = true;
    root.dataset.renderer = "dom";
    stop();
  }
  function prepareSource() {
    if (!source || !context) return;
    const panel = panels[current];
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    const width = Math.max(1, box.width);
    const height = Math.max(1, box.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5, 1100 / width, 750 / height);
    surface.width = Math.round(width * dpr);
    surface.height = Math.round(height * dpr);
    source.style.width = `${width}px`;
    source.style.minHeight = `${height}px`;
    source.replaceChildren(...[...panel.children].map((node) => node.cloneNode(true)));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    surface.requestPaint?.();
  }
  /** @param {number} now */
  function paint(now) {
    frame = 0;
    if (!context || !source || failed || !began) return;
    if (!visible || document.hidden || motion?.matches) {
      stop();
      return;
    }
    const progress = Math.min(1, (now - began) / 650);
    if (progress >= 1) {
      stop();
      return;
    }
    const width = source.offsetWidth;
    const height = source.offsetHeight;
    try {
      context.clearRect(0, 0, width, height);
      const amount = Math.sin(progress * Math.PI) * 20;
      for (let band = 0; band < 12; band++) {
        const y = (band * height) / 12;
        context.save();
        context.beginPath();
        context.rect(0, y, width, height / 12 + 1);
        context.clip();
        context.translate(Math.sin(band * 0.8 + progress * 6) * amount, 0);
        context.drawElementImage(source, 0, 0);
        context.restore();
      }
      surface.style.opacity = String(Math.sin(progress * Math.PI) * 0.85);
      root.dataset.renderer = "canvas";
      frame = requestAnimationFrame(paint);
    } catch {
      fallback();
    }
  }
  /** @param {number} next @param {boolean} animate */
  function select(next, animate) {
    stop();
    current = next;
    root.dataset.scene = String(next);
    if (hero instanceof HTMLElement) hero.dataset.heroScene = String(next);
    panels.forEach((panel, index) => {
      panel.hidden = index !== next;
    });
    buttons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(index === next));
    });
    document.dispatchEvent(new CustomEvent("tenka:scene", { detail: { index: next, animate } }));
    if (
      !animate ||
      motion?.matches ||
      !visible ||
      document.hidden ||
      document.documentElement.dataset.motion === "paused"
    )
      return;
    const panel = panels[next];
    if (panel && typeof panel.animate === "function") {
      animation = panel.animate(
        [
          { transform: "translateX(16px) skewY(-1deg)", opacity: 0.65 },
          { transform: "translateX(0) skewY(0deg)", opacity: 1 },
        ],
        { duration: 650, easing: "cubic-bezier(.22,1,.36,1)" },
      );
    }
    if (!context || failed) return;
    prepareSource();
    began = performance.now();
    frame = requestAnimationFrame(paint);
  }
  function initCanvas() {
    if (!("content" in surface)) return;
    try {
      const candidate = surface.getContext("2d");
      if (!candidate || !("drawElementImage" in candidate)) return;
      context = /** @type {SceneContext} */ (candidate);
      source = document.createElement("div");
      source.className = "platform-canvas-source";
      source.setAttribute("drawable", "");
      source.setAttribute("aria-hidden", "true");
      source.inert = true;
      surface.append(source);
      surface.addEventListener(
        "paint",
        () => {
          if (began && !frame) frame = requestAnimationFrame(paint);
        },
        options,
      );
    } catch {
      fallback();
    }
  }
  root.dataset.renderer = "dom";
  initCanvas();
  select(0, false);
  controls.hidden = false;
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index, true), options);
  });
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (!visible) stop();
        })
      : null;
  observer?.observe(root);
  let previousWidth = root.clientWidth;
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const width = root.clientWidth;
          if (width !== previousWidth) stop();
          previousWidth = width;
        })
      : null;
  resize?.observe(root);
  document.addEventListener("tenka:pause", stop, options);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) stop();
    },
    options,
  );
  motion?.addEventListener("change", stop, options);
  window.addEventListener(
    "pagehide",
    (event) => {
      stop();
      if (event.persisted) return;
      observer?.disconnect();
      resize?.disconnect();
      abort.abort();
      source?.remove();
    },
    options,
  );
})();
