// Motion is part of this page's requested experience. Semantic HTML is never gated by it.
(() => {
  const node = document.querySelector(".hero");
  if (!(node instanceof HTMLElement)) return;
  const hero = node;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const toggles = [...document.querySelectorAll("[data-motion-toggle]")];
  const videos = [...document.querySelectorAll("video[data-ambient-video]")].filter(
    (video) => video instanceof HTMLVideoElement,
  );
  const choices = [...hero.querySelectorAll("[data-scene-select]")].filter(
    (button) => button instanceof HTMLButtonElement,
  );
  const visible = new Map(videos.map((video) => [video, false]));
  /** @type {Set<Animation>} */
  const animations = new Set();
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let userPaused = false;
  let explicitMotion = false;
  let heroVisible = true;
  let timer = 0;

  function running() {
    return !userPaused && (!preference.matches || explicitMotion) && !document.hidden;
  }
  function cancelAnimations() {
    for (const animation of animations) animation.cancel();
    animations.clear();
    document.dispatchEvent(new Event("tenka:pause"));
  }
  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!running() || !heroVisible) return;
    timer = window.setTimeout(() => {
      if (!hero.contains(document.activeElement)) {
        const current = Number(hero.dataset.heroScene || 0);
        choices[(current + 1) % choices.length]?.click();
      }
      schedule();
    }, 8000);
  }
  function syncMedia() {
    for (const video of videos) {
      const panel = video.closest("[data-scene-panel], [data-entry-panel]");
      const selected =
        !(panel instanceof HTMLElement) ||
        (!panel.hidden &&
          (!panel.hasAttribute("data-entry-panel") || panel.hasAttribute("data-entry-current")));
      if (!running() || !visible.get(video) || !selected) {
        video.pause();
        continue;
      }
      if (!video.getAttribute("src") && video.dataset.src) video.src = video.dataset.src;
      video.muted = true;
      const playing = video.play();
      // iOS low-power/autoplay policy can reject playback; the real screenshot poster remains.
      playing
        ?.then(() => {
          video.dataset.playback = "playing";
        })
        .catch(() => {
          video.dataset.playback = "poster";
        });
    }
  }
  function reflect() {
    const active = running();
    document.documentElement.dataset.motion = active ? "running" : "paused";
    for (const toggle of toggles) {
      if (!(toggle instanceof HTMLElement)) continue;
      toggle.hidden = false;
      const pause = toggle.querySelector("[data-motion-pause]");
      const play = toggle.querySelector("[data-motion-play]");
      if (pause instanceof HTMLElement) pause.hidden = !active;
      if (play instanceof HTMLElement) play.hidden = active;
    }
    document.dispatchEvent(new Event("tenka:motion"));
    if (!active) cancelAnimations();
    syncMedia();
    schedule();
  }
  /** @param {Element} element @param {Keyframe[]} frames @param {KeyframeAnimationOptions} settings */
  function animate(element, frames, settings) {
    if (typeof element.animate !== "function") return;
    const animation = element.animate(frames, settings);
    animations.add(animation);
    animation.finished
      .then(() => animations.delete(animation))
      .catch(() => animations.delete(animation));
  }
  function flow() {
    if (!running() || !heroVisible || preference.matches) return;
    cancelAnimations();
    const lines = [...hero.querySelectorAll("h1 .motion-line, h1 > em")];
    const travel = hero.clientWidth < 700 ? 12 : 36;
    lines.forEach((line, index) => {
      animate(
        line,
        [
          { transform: "translateX(0) skewX(0deg)", opacity: 1 },
          {
            transform: `translateX(-${travel}px) skewX(-4deg) scaleX(1.01)`,
            opacity: 0.72,
            offset: 0.32,
          },
          {
            transform: `translateX(${travel}px) skewX(4deg) scaleX(.99)`,
            opacity: 0.85,
            offset: 0.53,
          },
          { transform: "translateX(0) skewX(0deg)", opacity: 1 },
        ],
        { duration: 1300, delay: index * 90, easing: "cubic-bezier(.22,.7,.2,1)" },
      );
    });
    const panel = hero.querySelector("[data-scene-panel]:not([hidden])");
    const media = panel?.querySelector("video");
    if (media)
      animate(
        media,
        [
          {
            transform: "translateX(-5%) scale(1.12) skewY(-4deg)",
            filter: "blur(7px)",
            opacity: 0.55,
          },
          {
            transform: "translateX(1%) scale(1.04) skewY(1deg)",
            filter: "blur(1px)",
            opacity: 0.92,
            offset: 0.68,
          },
          { transform: "translateX(0) scale(1) skewY(0deg)", filter: "blur(0)", opacity: 1 },
        ],
        { duration: 1500, easing: "cubic-bezier(.22,.7,.2,1)" },
      );
  }
  for (const toggle of toggles)
    toggle.addEventListener(
      "click",
      () => {
        if (running()) userPaused = true;
        else {
          userPaused = false;
          explicitMotion = true;
        }
        reflect();
      },
      options,
    );
  document.addEventListener(
    "tenka:scene",
    (event) => {
      syncMedia();
      if (event instanceof CustomEvent && event.detail.animate) flow();
      schedule();
    },
    options,
  );
  document.addEventListener("tenka:entry", syncMedia, options);
  /** @param {IntersectionObserverEntry} entry */
  function observeEntry(entry) {
    if (entry.target === hero) {
      heroVisible = entry.isIntersecting;
      if (!heroVisible) cancelAnimations();
      return;
    }
    if (entry.target instanceof HTMLVideoElement) {
      visible.set(entry.target, entry.isIntersecting);
      return;
    }
    if (!(entry.target instanceof HTMLElement)) return;
    entry.target.dataset.inview = String(entry.isIntersecting);
    if (entry.isIntersecting) entry.target.dataset.motionSeen = "true";
  }
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach(observeEntry);
            syncMedia();
            schedule();
          },
          { threshold: 0.12 },
        )
      : null;
  observer?.observe(hero);
  for (const video of videos) observer?.observe(video);
  for (const section of document.querySelectorAll(
    "main > .platform-section, .platform-entry-media",
  ))
    observer?.observe(section);
  if (!observer) {
    for (const video of videos)
      visible.set(video, Boolean(video.closest('[data-scene-panel="0"]')));
  }
  preference.addEventListener(
    "change",
    () => {
      explicitMotion = false;
      reflect();
    },
    options,
  );
  document.addEventListener("visibilitychange", reflect, options);
  window.addEventListener(
    "pagehide",
    (event) => {
      clearTimeout(timer);
      cancelAnimations();
      videos.forEach((video) => {
        video.pause();
      });
      if (event.persisted) return;
      observer?.disconnect();
      abort.abort();
    },
    options,
  );
  window.addEventListener("pageshow", reflect, options);
  reflect();
})();
