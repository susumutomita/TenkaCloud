(() => {
  const frame = document.querySelector("#diagram-frame");
  const image = document.querySelector("#diagram-image");
  const output = document.querySelector("#zoom-value");
  const original = document.querySelector("#open-svg");
  const buttons = [...document.querySelectorAll("[data-view]")];
  let scale = 1;

  function zoom(value) {
    scale = Math.max(0.5, Math.min(4, value));
    image.style.width = `${scale * 100}%`;
    output.textContent = `${Math.round(scale * 100)}%`;
    document.querySelector("#zoom-out").disabled = scale <= 0.5;
    document.querySelector("#zoom-in").disabled = scale >= 4;
  }

  function select(view) {
    const selected = view === "evolution" ? "evolution" : "aws";
    const button = buttons.find((item) => item.dataset.view === selected);
    image.src = button.dataset.src;
    image.alt =
      selected === "evolution"
        ? "クラウド非依存を目指した初期方針とAWS-nativeへの設計転換"
        : "TenkaCloud Liteの運営AWSアカウントとチーム別AWSアカウント、管理・配置・競技・認証経路";
    original.href = image.getAttribute("src");
    for (const item of buttons) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    for (const caption of document.querySelectorAll("[data-caption]")) {
      caption.hidden = caption.dataset.caption !== selected;
    }
    zoom(1);
    frame.scrollTo(0, 0);
    // Embedded manuals can prohibit URL changes without prohibiting local viewing.
    try {
      const url = new URL(location.href);
      url.searchParams.set("view", selected);
      history.replaceState(null, "", url);
    } catch {
      // The selected image remains visible; no remote operation is implied.
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", () => select(button.dataset.view));
  }
  document.querySelector("#zoom-in").addEventListener("click", () => zoom(scale + 0.25));
  document.querySelector("#zoom-out").addEventListener("click", () => zoom(scale - 0.25));
  document.querySelector("#fit").addEventListener("click", () => {
    zoom(1);
    frame.scrollTo(0, 0);
  });

  let drag = null;
  image.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop };
    image.setPointerCapture(event.pointerId);
    frame.classList.add("dragging");
  });
  image.addEventListener("pointermove", (event) => {
    if (!drag) return;
    frame.scrollLeft = drag.left - (event.clientX - drag.x);
    frame.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const release = () => {
    drag = null;
    frame.classList.remove("dragging");
  };
  image.addEventListener("pointerup", release);
  image.addEventListener("pointercancel", release);
  image.addEventListener("lostpointercapture", release);
  image.addEventListener("error", () => {
    document.querySelector("#diagram-error").hidden = false;
  });
  image.addEventListener("load", () => {
    document.querySelector("#diagram-error").hidden = true;
  });
  select(new URL(location.href).searchParams.get("view"));
})();
