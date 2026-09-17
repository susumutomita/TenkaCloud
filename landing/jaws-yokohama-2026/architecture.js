(() => {
  const frame = document.querySelector("#diagram-frame");
  const image = document.querySelector("#diagram-image");
  const output = document.querySelector("#zoom-value");
  const original = document.querySelector("#open-svg");
  const buttons = [...document.querySelectorAll("[data-view]")];
  let scale = 1;

  function zoom(value) {
    scale = Math.max(0.5, Math.min(12, value));
    image.style.width = `${scale * 100}%`;
    output.textContent = `${Math.round(scale * 100)}%`;
    document.querySelector("#zoom-out").disabled = scale <= 0.5;
    document.querySelector("#zoom-in").disabled = scale >= 12;
  }

  function select(view) {
    const selected = buttons.some((item) => item.dataset.view === view) ? view : "saas";
    const button = buttons.find((item) => item.dataset.view === selected);
    image.src = button.dataset.src;
    const descriptions = {
      saas: "既存Draw.io原本のSaaS物理構成図。AWSサービスとスタックの配置・配線",
      sbt: "SBTの2層とTenkaCloudが追加した問題デプロイエンジン・競技者コンソール",
      deploy:
        "開催者のデプロイ操作からEventBridge、Step Functions、Lambda、チーム別AWSのCloudFormationへ進む流れ",
      aws: "TenkaCloud Liteの運営AWSアカウントとチーム別AWSアカウント、管理・デプロイ・競技・認証経路",
      evolution: "クラウド非依存を目指した初期方針とAWS-nativeへの設計転換",
    };
    image.alt = descriptions[selected];
    original.href = image.getAttribute("src");
    document.querySelector("#open-source").href =
      button.dataset.source || "assets/architecture.drawio";
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
