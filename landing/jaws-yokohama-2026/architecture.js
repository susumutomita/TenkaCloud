(() => {
  "use strict";
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
    const evolution = view === "evolution";
    image.src = buttons.find(button => button.dataset.view === (evolution ? "evolution" : "aws")).dataset.src;
    image.alt = evolution ? "クラウド非依存を目指した初期方針とAWS-nativeへの設計転換" : "TenkaCloud Liteの運営AWSアカウントとチーム別AWSアカウント、管理・配置・競技・認証経路";
    original.href = image.getAttribute("src");
    buttons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === (evolution ? "evolution" : "aws"))));
    document.querySelectorAll("[data-caption]").forEach(caption => caption.hidden = caption.dataset.caption !== (evolution ? "evolution" : "aws"));
    zoom(1); frame.scrollTo(0, 0);
    // URL persistence is optional in an embedded/sandboxed manual viewer.
    try {
      const url = new URL(location.href);
      url.searchParams.set("view", evolution ? "evolution" : "aws");
      history.replaceState(null, "", url);
    } catch { /* Keep the selected diagram usable when URL updates are forbidden. */ }
  }
  buttons.forEach(button => button.addEventListener("click", () => select(button.dataset.view)));
  document.querySelector("#zoom-in").addEventListener("click", () => zoom(scale + 0.25));
  document.querySelector("#zoom-out").addEventListener("click", () => zoom(scale - 0.25));
  document.querySelector("#fit").addEventListener("click", () => { zoom(1); frame.scrollTo(0, 0); });
  let drag = null;
  image.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    event.preventDefault(); drag = {x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop};
    image.setPointerCapture(event.pointerId); frame.classList.add("dragging");
  });
  image.addEventListener("pointermove", (event) => {
    if (!drag) return;
    frame.scrollLeft = drag.left - (event.clientX - drag.x); frame.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const release = () => { drag = null; frame.classList.remove("dragging"); };
  image.addEventListener("pointerup", release); image.addEventListener("pointercancel", release); image.addEventListener("lostpointercapture", release);
  image.addEventListener("error", () => { document.querySelector("#diagram-error").hidden = false; });
  image.addEventListener("load", () => { document.querySelector("#diagram-error").hidden = true; });
  select(new URL(location.href).searchParams.get("view"));
})();
