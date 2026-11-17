// One-shot motion decorates readable HTML; plan conditions are never hidden.
(() => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** @type {Set<Animation>} */
  const animations = new Set();
  const abort = new AbortController();
  const options = { signal: abort.signal };
  function cancel() {
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  /** @param {IntersectionObserverEntry} entry */
  function reveal(entry) {
    if (!entry.isIntersecting) return;
    observer?.unobserve(entry.target);
    if (preference.matches || document.hidden || typeof entry.target.animate !== "function") return;
    try {
      const animation = entry.target.animate(
        [
          { transform: "translateY(18px)", opacity: 0.85 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 950, easing: "cubic-bezier(.2,.7,.2,1)" },
      );
      animations.add(animation);
      animation.finished
        .then(() => animations.delete(animation))
        .catch(() => animations.delete(animation));
    } catch (error) {
      console.warn("Pricing motion unavailable; the plan remains readable.", error);
    }
  }
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach(reveal);
          },
          { threshold: 0.12 },
        )
      : null;
  document.querySelectorAll("[data-pricing-arrive]").forEach((node) => {
    observer?.observe(node);
  });
  preference.addEventListener("change", cancel, options);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) cancel();
    },
    options,
  );
  window.addEventListener(
    "pagehide",
    (event) => {
      cancel();
      if (event.persisted) return;
      observer?.disconnect();
      abort.abort();
    },
    options,
  );
})();
