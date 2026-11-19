// Native radio controls still switch the static screenshots when JavaScript is unavailable.
// Animation only decorates the media; headings, links and selection remain ordinary HTML.
(() => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  for (const root of document.querySelectorAll("[data-entry-gallery]")) {
    if (root instanceof HTMLElement) initialize(root);
  }
  /** @param {HTMLElement} root */
  function initialize(root) {
    const stageNode = root.querySelector("[data-entry-stage]");
    if (!(stageNode instanceof HTMLElement)) return;
    const stage = stageNode;
    const panels = [...stage.querySelectorAll("[data-entry-panel]")].filter(
      (panel) => panel instanceof HTMLElement,
    );
    const choices = [...root.querySelectorAll('input[type="radio"]')].filter(
      (input) => input instanceof HTMLInputElement,
    );
    if (!panels.length || panels.length !== choices.length) return;
    const abort = new AbortController();
    const options = { signal: abort.signal };
    /** @type {Set<Animation>} */
    const animations = new Set();
    let current = Math.max(
      0,
      choices.findIndex((input) => input.checked),
    );
    let generation = 0;
    let printing = false;
    /** @param {number} next */
    function update(next) {
      current = next;
      panels.forEach((panel, index) => {
        panel.toggleAttribute("data-entry-current", index === current);
        // The native hidden IDL falls back to boolean hidden in older browsers.
        Reflect.set(panel, "hidden", index === current ? false : "until-found");
      });
      choices.forEach((input, index) => {
        input.checked = index === current;
      });
      root.dataset.entryScene = String(current);
      document.dispatchEvent(new Event("tenka:entry"));
    }
    function settle() {
      generation++;
      for (const animation of animations) animation.cancel();
      animations.clear();
      stage.querySelectorAll("[data-transition-layer]").forEach((layer) => {
        layer.remove();
      });
      stage.dataset.transition = "idle";
    }
    /** @param {Element} element @param {Keyframe[]} frames @param {KeyframeAnimationOptions} settings */
    function animate(element, frames, settings) {
      const animation = element.animate(frames, settings);
      animations.add(animation);
      return animation.finished;
    }
    /** @param {number} next @param {boolean} moving */
    function select(next, moving) {
      if (next < 0 || next >= panels.length || next === current) return;
      settle();
      const outgoing = panels[current]?.querySelector("video");
      const incoming = panels[next];
      const media = incoming?.querySelector(".platform-entry-media");
      const canMove =
        moving &&
        !preference.matches &&
        !document.hidden &&
        document.documentElement.dataset.motion !== "paused" &&
        typeof media?.animate === "function";
      const layer = canMove && outgoing instanceof HTMLVideoElement ? snapshot(outgoing) : null;
      update(next);
      if (!canMove || !(media instanceof HTMLElement) || !incoming) return;
      transition(incoming, media, layer);
    }
    /** @param {HTMLElement} incoming @param {HTMLElement} media @param {HTMLElement | null} layer */
    function transition(incoming, media, layer) {
      const sequence = generation;
      stage.dataset.transition = "moving";
      const jobs = [];
      try {
        if (layer) {
          media.append(layer);
          [...layer.children].forEach((strip, index) => {
            jobs.push(
              animate(
                strip,
                [
                  { transform: "perspective(900px) rotateY(0deg) translateY(0)", opacity: 1 },
                  { transform: "perspective(900px) rotateY(-88deg) translateY(-12%)", opacity: 0 },
                ],
                {
                  duration: 850,
                  delay: index * 55,
                  easing: "cubic-bezier(.6,0,.2,1)",
                  fill: "forwards",
                },
              ),
            );
          });
        }
        const video = media.querySelector("video");
        if (video)
          jobs.push(
            animate(
              video,
              [
                { transform: "translateX(7%) scale(1.08)", opacity: 0.8 },
                { transform: "translateX(0) scale(1)", opacity: 1 },
              ],
              { duration: 1400, easing: "cubic-bezier(.2,.7,.2,1)" },
            ),
          );
        incoming.querySelectorAll(".platform-entry-copy > :not(a)").forEach((text, index) => {
          jobs.push(
            animate(
              text,
              [
                { transform: "translateY(24px)", opacity: 0.7 },
                { transform: "translateY(0)", opacity: 1 },
              ],
              { duration: 850, delay: 150 + index * 90, easing: "cubic-bezier(.2,.7,.2,1)" },
            ),
          );
        });
        Promise.allSettled(jobs).then(() => {
          if (sequence === generation) settle();
        });
      } catch (error) {
        console.warn("TenkaCloud scene motion unavailable; keeping the selected screen.", error);
        settle();
      }
    }
    choices.forEach((input, index) => {
      input.addEventListener(
        "change",
        () => {
          if (input.checked) select(index, true);
        },
        options,
      );
    });
    panels.forEach((panel, index) => {
      panel.addEventListener(
        "beforematch",
        () => {
          select(index, false);
        },
        options,
      );
    });
    function revealHash() {
      let id;
      try {
        id = decodeURIComponent(location.hash.slice(1));
      } catch {
        return;
      }
      const target = document.getElementById(id);
      const index = panels.findIndex((panel) => target && panel.contains(target));
      if (index >= 0) select(index, false);
    }
    document.addEventListener(
      "tenka:motion",
      () => {
        if (document.documentElement.dataset.motion === "paused") settle();
      },
      options,
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) settle();
      },
      options,
    );
    preference.addEventListener("change", settle, options);
    window.addEventListener("hashchange", revealHash, options);
    window.addEventListener(
      "beforeprint",
      () => {
        if (printing) return;
        printing = true;
        settle();
        panels.forEach((panel) => {
          panel.hidden = false;
        });
      },
      options,
    );
    window.addEventListener(
      "afterprint",
      () => {
        printing = false;
        update(current);
      },
      options,
    );
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            if (entries.every((entry) => !entry.isIntersecting)) settle();
          })
        : null;
    observer?.observe(stage);
    let stageWidth = stage.getBoundingClientRect().width;
    const resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || width === stageWidth) return;
            stageWidth = width;
            settle();
          })
        : null;
    resize?.observe(stage);
    window.addEventListener(
      "pagehide",
      (event) => {
        settle();
        if (event.persisted) return;
        observer?.disconnect();
        resize?.disconnect();
        abort.abort();
      },
      options,
    );
    update(current);
    root.dataset.entryReady = "true";
    revealHash();
  }
  /** @param {HTMLVideoElement} video */
  function snapshot(video) {
    const layer = document.createElement("div");
    layer.className = "platform-transition-layer";
    layer.dataset.transitionLayer = "";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    try {
      const frame = document.createElement("canvas");
      const box = video.getBoundingClientRect();
      const ratio = Math.min(1, 1024 / Math.max(1, box.width), 640 / Math.max(1, box.height));
      frame.width = Math.max(1, Math.round(box.width * ratio));
      frame.height = Math.max(1, Math.round(box.height * ratio));
      const context = frame.getContext("2d");
      if (!context || video.readyState < 2 || !video.videoWidth)
        throw new Error("Video frame not ready");
      context.fillStyle = "#ededeb";
      context.fillRect(0, 0, frame.width, frame.height);
      const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.drawImage(
        video,
        (frame.width - width) / 2,
        (frame.height - height) / 2,
        width,
        height,
      );
      for (let index = 0; index < 8; index++) {
        const strip = document.createElement("canvas");
        strip.width = Math.ceil(frame.width / 8);
        strip.height = frame.height;
        const stripContext = strip.getContext("2d");
        if (!stripContext) throw new Error("Canvas snapshot unavailable");
        stripContext.drawImage(
          frame,
          (index * frame.width) / 8,
          0,
          frame.width / 8,
          frame.height,
          0,
          0,
          strip.width,
          strip.height,
        );
        layer.append(strip);
      }
      layer.dataset.snapshot = "video";
    } catch {
      // Poster transition is also available when video decoding or canvas capture is unavailable.
      layer.replaceChildren();
      const poster = video.cloneNode(false);
      if (poster instanceof HTMLVideoElement) {
        poster.removeAttribute("src");
        poster.removeAttribute("data-ambient-video");
        poster.preload = "none";
        layer.append(poster);
      }
      layer.dataset.snapshot = "poster";
    }
    return layer;
  }
})();
