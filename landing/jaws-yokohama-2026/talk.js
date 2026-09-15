(() => {
  const slides = [...document.querySelectorAll(".slide")];
  if (!slides.length) return;
  document.documentElement.classList.add("js");
  const previous = document.querySelector("#previous");
  const next = document.querySelector("#next");
  const position = document.querySelector("#position");
  const notes = document.querySelector("#notes");
  const notesButton = document.querySelector("#notes-button");
  let index = 0;

  function hashIndex() {
    const raw = location.hash.slice(1);
    return /^\d+$/.test(raw) ? Math.min(slides.length - 1, Math.max(0, Number(raw) - 1)) : 0;
  }

  // Measure the unscaled slide after layout changes, including loaded media.
  function fitSlide() {
    const deck = document.querySelector("#deck");
    if (innerWidth <= 900 || document.body.classList.contains("reading")) {
      deck.style.height = "";
      return;
    }
    const height = Math.max(810, slides[index].offsetHeight);
    const footer = document.querySelector("body > footer");
    const available = Math.max(
      320,
      innerHeight - deck.getBoundingClientRect().top - footer.offsetHeight,
    );
    const scale = Math.min(innerWidth / 1440, available / height, 1);
    deck.style.setProperty("--deck-scale", String(scale));
    deck.style.height = `${height * scale}px`;
  }

  window.addEventListener("resize", () => requestAnimationFrame(fitSlide));
  for (const image of document.querySelectorAll("img")) {
    image.addEventListener("load", fitSlide);
  }
  for (const video of document.querySelectorAll("video")) {
    video.addEventListener("loadedmetadata", fitSlide);
  }
  document.fonts?.ready.then(fitSlide);

  function syncVisibility() {
    const reading = document.body.classList.contains("reading");
    slides.forEach((slide, slideIndex) => {
      const hidden = !reading && slideIndex !== index;
      slide.hidden = hidden;
      slide.setAttribute("aria-hidden", String(hidden));
      if (hidden) {
        for (const video of slide.querySelectorAll("video")) {
          if (!video.paused) video.pause();
        }
      }
    });
  }

  function show(value, changeHash = true) {
    index = Math.max(0, Math.min(slides.length - 1, value));
    syncVisibility();
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    position.textContent = `${index + 1} / ${slides.length}`;
    notes.textContent =
      slides[index].querySelector(".speaker-notes")?.textContent.trim() || "補足スライドです。";
    if (changeHash) history.replaceState(null, "", `#${index + 1}`);
    requestAnimationFrame(fitSlide);
  }

  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  window.addEventListener("hashchange", () => show(hashIndex(), false));
  notesButton.addEventListener("click", () => {
    notes.hidden = !notes.hidden;
    notesButton.setAttribute("aria-expanded", String(!notes.hidden));
  });
  document.querySelector("#print").addEventListener("click", () => window.print());
  document.querySelector("#reading").addEventListener("click", (event) => {
    const reading = document.body.classList.toggle("reading");
    event.currentTarget.setAttribute("aria-pressed", String(reading));
    syncVisibility();
    requestAnimationFrame(fitSlide);
  });
  document.querySelector("#fullscreen").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen();
      else position.textContent = "全画面はブラウザの機能を使用してください";
    } catch {
      position.textContent = "全画面を開始できませんでした";
    }
  });

  document.addEventListener("keydown", (event) => {
    const interactive =
      "button,a,summary,input,select,textarea,video,audio,iframe,[contenteditable]";
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.target.closest?.(interactive) ||
      document.body.classList.contains("reading")
    )
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
    if (event.key.toLowerCase() === "n") notesButton.click();
  });

  const diagram = document.querySelector("#slide-architecture-svg");
  function setDiagramView(box) {
    diagram.setAttribute("viewBox", box);
    const selected = [...document.querySelectorAll("[data-view-box]")].find(
      (button) => button.dataset.viewBox === box,
    );
    document.querySelector("#diagram-summary").textContent = selected.dataset.summary;
    const rect = document.querySelector("#slide-architecture-clip-rect");
    const values = box.split(" ");
    ["x", "y", "width", "height"].forEach((name, valueIndex) => {
      rect.setAttribute(name, values[valueIndex]);
    });
  }
  for (const button of document.querySelectorAll("[data-view-box]")) {
    button.addEventListener("click", () => {
      setDiagramView(button.dataset.viewBox);
      for (const other of document.querySelectorAll("[data-view-box]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
  }

  const timer = document.querySelector("#timer");
  const timerButton = document.querySelector("#timer-button");
  let interval = null;
  let elapsed = 0;
  let start = 0;
  function updateTimer() {
    const seconds = Math.floor(
      (elapsed + (interval === null ? 0 : performance.now() - start)) / 1000,
    );
    timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    timer.classList.toggle("over", seconds >= 600);
  }
  timerButton.addEventListener("click", () => {
    if (interval === null) {
      start = performance.now();
      interval = setInterval(updateTimer, 250);
      timerButton.textContent = "タイマー停止";
    } else {
      elapsed += performance.now() - start;
      clearInterval(interval);
      interval = null;
      timerButton.textContent = "タイマー再開";
    }
    updateTimer();
  });
  document.querySelector("#reset-timer").addEventListener("click", () => {
    elapsed = 0;
    start = performance.now();
    updateTimer();
  });

  let diagramViewBeforePrint = null;
  window.addEventListener("beforeprint", () => {
    for (const slide of slides) slide.setAttribute("aria-hidden", "false");
    diagramViewBeforePrint = diagram.getAttribute("viewBox");
    setDiagramView(diagram.dataset.fullViewBox);
  });
  window.addEventListener("afterprint", () => {
    if (diagramViewBeforePrint) setDiagramView(diagramViewBeforePrint);
    show(index, false);
  });
  show(hashIndex(), false);
})();
