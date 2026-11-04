(() => {
  const slides = [...document.querySelectorAll(".slide")];
  if (!slides.length) return;
  document.documentElement.classList.add("js");

  const previous = document.querySelector("#previous");
  const next = document.querySelector("#next");
  const position = document.querySelector("#position");
  const deck = document.querySelector("#deck");
  let index = 0;

  function hashIndex() {
    const raw = location.hash.slice(1);
    return /^\d+$/.test(raw) ? Math.min(slides.length - 1, Math.max(0, Number(raw) - 1)) : 0;
  }

  function fitSlide() {
    if (innerWidth <= 900) {
      deck.style.height = "";
      return;
    }
    const height = Math.max(810, slides[index].offsetHeight);
    const footer = document.querySelector("body > footer");
    const available = Math.max(
      320,
      innerHeight - deck.getBoundingClientRect().top - (footer?.offsetHeight ?? 0),
    );
    const scale = Math.min(innerWidth / 1440, available / height, 1);
    deck.style.setProperty("--deck-scale", String(scale));
    deck.style.height = `${height * scale}px`;
  }

  for (const player of document.querySelectorAll("[data-youtube-id]")) {
    const button = player.querySelector(".demo-play");
    button.addEventListener("click", () => {
      const iframe = document.createElement("iframe");
      const url = new URL(`https://www.youtube-nocookie.com/embed/${player.dataset.youtubeId}`);
      url.search = new URLSearchParams({
        start: player.dataset.youtubeStart ?? "0",
        end: player.dataset.youtubeEnd ?? "60",
        autoplay: "1",
        rel: "0",
        cc_lang_pref: "ja",
        cc_load_policy: "1",
      }).toString();
      iframe.src = url.href;
      iframe.title = button.getAttribute("aria-label");
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.addEventListener("load", fitSlide);
      button.hidden = true;
      player.append(iframe);
    });
  }

  function syncVisibility() {
    slides.forEach((slide, slideIndex) => {
      const hidden = slideIndex !== index;
      slide.hidden = hidden;
      slide.setAttribute("aria-hidden", String(hidden));
      if (hidden) {
        for (const video of slide.querySelectorAll("video")) video.pause();
        for (const player of slide.querySelectorAll("[data-youtube-id]")) {
          player.querySelector("iframe")?.remove();
          player.querySelector(".demo-play").hidden = false;
        }
      }
    });
  }

  function show(value, changeHash = true) {
    index = Math.max(0, Math.min(slides.length - 1, value));
    syncVisibility();
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    position.textContent = slides[index].dataset.slideLabel ?? `${index + 1} / ${slides.length}`;
    if (changeHash) history.replaceState(null, "", `#${index + 1}`);
    requestAnimationFrame(fitSlide);
  }

  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  window.addEventListener("hashchange", () => show(hashIndex(), false));
  window.addEventListener("resize", () => requestAnimationFrame(fitSlide));
  document.fonts?.ready.then(fitSlide);
  for (const image of document.querySelectorAll("img")) image.addEventListener("load", fitSlide);

  document.addEventListener("keydown", (event) => {
    const interactive =
      "button,a,summary,input,select,textarea,video,audio,iframe,[contenteditable]";
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest?.(interactive))
      return;
    if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      show(index + 1);
    }
    if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      show(index - 1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      show(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      show(slides.length - 1);
    }
  });

  window.addEventListener("beforeprint", () => {
    for (const slide of slides) slide.setAttribute("aria-hidden", "false");
  });
  window.addEventListener("afterprint", () => show(index, false));

  show(hashIndex(), false);
})();
