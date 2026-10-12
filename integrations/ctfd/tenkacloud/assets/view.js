CTFd._internal.challenge.data = undefined;
CTFd._internal.challenge.renderer = null;
CTFd._internal.challenge.preRender = () => {
  // The CTFd template renderer owns the challenge markup.
};
CTFd._internal.challenge.render = null;
function bindTenkaCloudRuntime() {
  const root = document.getElementById("tenkacloud-runtime");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "true";
  const key = root.querySelector("#tenkacloud-key");
  const status = root.querySelector("#tenkacloud-status");
  const links = root.querySelector("#tenkacloud-links");
  const buttons = root.querySelectorAll("[data-tenka-action]");
  let busy = false;
  let timer;
  let generation = 0;
  const originalSubmit = CTFd.pages?.challenge?.submitChallenge;
  const submit = (id, submission, preview) => {
    if (String(id) !== root.dataset.challengeId) return originalSubmit(id, submission, preview);
    return submitTenkaCloud(id, submission, preview);
  };
  if (originalSubmit) CTFd.pages.challenge.submitChallenge = submit;
  const clear = () => {
    generation += 1;
    clearTimeout(timer);
    key.value = "";
    links.replaceChildren();
    if (CTFd.pages?.challenge?.submitChallenge === submit)
      CTFd.pages.challenge.submitChallenge = originalSubmit;
  };
  const modal = root.closest(".modal");
  modal?.addEventListener("hidden.bs.modal", clear, { once: true });
  // Deprecated theme uses Bootstrap 4 jQuery events; core uses Bootstrap 5 native events.
  CTFd.lib.$(modal).off("hidden.bs.modal.tenkacloud").on("hidden.bs.modal.tenkacloud", clear);
  function showLinks(entries) {
    for (const link of entries) {
      const url = new URL(link.url);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const item = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.textContent = link.name;
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      item.append(anchor);
      links.append(item);
    }
  }
  async function callRuntime(action) {
    const response = await CTFd.fetch(
      `/plugins/tenkacloud/runtime/${root.dataset.challengeId}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_key: key.value }),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.message || "Environment request failed.");
    return result.data;
  }
  function showState(data) {
    showLinks(data.links || []);
    if (data.accessError) {
      // Running without a usable link is not ready; keep retrying at a slower pace.
      status.textContent =
        "Environment: running, but its link is unavailable. Retrying; ask the organizer if this persists.";
      timer = setTimeout(() => {
        void perform("read");
      }, 5000);
      return;
    }
    status.textContent = data.message
      ? `Environment: ${data.status}. ${data.message}`
      : `Environment: ${data.status}`;
    if (["accepted", "starting", "stopping"].includes(data.status)) {
      timer = setTimeout(() => {
        void perform("read");
      }, 1500);
    }
  }
  const visible = (current) => root.isConnected && current === generation;
  async function perform(action) {
    if (busy || !root.isConnected) return;
    const current = generation;
    busy = true;
    clearTimeout(timer);
    links.replaceChildren();
    buttons.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = "Checking environment…";
    try {
      const data = await callRuntime(action);
      if (!visible(current)) return;
      showState(data);
    } catch (error) {
      if (visible(current)) {
        status.textContent = error instanceof Error ? error.message : "Environment request failed.";
      }
    } finally {
      busy = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      void perform(button.dataset.tenkaAction);
    });
  });
}
CTFd._internal.challenge.postRender = () => {
  // Core's Alpine template is committed after postRender; deprecated renders synchronously.
  setTimeout(bindTenkaCloudRuntime, 0);
};
CTFd._internal.challenge.submit = (preview) => {
  return submitTenkaCloud(
    Number(CTFd.lib.$("#challenge-id").val()),
    CTFd.lib.$("#challenge-input").val(),
    preview,
  );
};
async function submitTenkaCloud(id, submission, preview) {
  const response = await CTFd.fetch(
    `/api/v1/challenges/attempt${preview || CTFd.config.preview ? "?preview=true" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: id,
        submission,
        team_key: document.getElementById("tenkacloud-key")?.value,
      }),
    },
  );
  const result = await response.json();
  return result.data
    ? result
    : {
        success: true,
        data: {
          // CTFd's non-attempt response category; keep the actual failure reason in message.
          status: "ratelimited",
          message:
            result.message ||
            "Flag verification is unavailable. Retry after checking the environment.",
        },
      };
}
