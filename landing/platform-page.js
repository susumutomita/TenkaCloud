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
