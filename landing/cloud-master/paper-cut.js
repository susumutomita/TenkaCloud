const lifetimes = new WeakMap();
const MAX_SLICES = 8;
const DURATION_MS = 440;
export function cutStyle(uid, combo, width, height) {
  const variant = Math.abs(uid) % 3;
  const [left, right] = [
    [38, 62],
    [62, 38],
    [50, 50],
  ][variant];
  const strength = [3, 5, 10].filter((threshold) => combo >= threshold).length;
  return {
    variant,
    strength,
    upper: `polygon(0 0,100% 0,100% ${right}%,0 ${left}%)`,
    lower: `polygon(0 ${left}%,100% ${right}%,100% 100%,0 100%)`,
    angle: (Math.atan2(((right - left) * height) / 100, width) * 180) / Math.PI,
    spread: 18 + strength * 7,
  };
}
function removeSlice(node) {
  clearTimeout(lifetimes.get(node));
  lifetimes.delete(node);
  node.remove();
}
export function clearSlices(host) {
  for (const node of [...host.children]) removeSlice(node);
}
function fragment(node, box, style, clip, part) {
  const copy = node.cloneNode(true);
  copy.className = `paper-fragment part-${part}`;
  copy.removeAttribute("style");
  copy.removeAttribute("data-uid");
  copy.removeAttribute("id");
  copy.removeAttribute("aria-label");
  copy.removeAttribute("aria-keyshortcuts");
  copy.setAttribute("aria-hidden", "true");
  copy.tabIndex = -1;
  copy.disabled = true;
  for (const child of copy.querySelectorAll("[id]")) child.removeAttribute("id");
  for (const key of [
    "background",
    "border",
    "border-radius",
    "box-shadow",
    "padding",
    "font",
    "color",
    "text-align",
    "letter-spacing",
    "line-height",
    "display",
    "flex-direction",
    "gap",
    "align-items",
    "white-space",
    "word-break",
  ])
    copy.style.setProperty(key, style.getPropertyValue(key));
  Object.assign(copy.style, {
    width: `${box.width}px`,
    height: `${box.height}px`,
    boxSizing: "border-box",
    clipPath: clip,
  });
  return copy;
}
export function sliceCard(node, host, { uid, combo, reduced = false }) {
  if (reduced || !node.isConnected) return null;
  const box = node.getBoundingClientRect(),
    origin = host.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const style = getComputedStyle(node),
    cut = cutStyle(uid, combo, box.width, box.height);
  const effect = document.createElement("div");
  effect.className = `paper-cut tier-${cut.strength}`;
  effect.dataset.pattern = String(cut.variant);
  effect.setAttribute("aria-hidden", "true");
  Object.assign(effect.style, {
    left: `${box.left - origin.left}px`,
    top: `${box.top - origin.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  effect.style.setProperty("--cut-angle", `${cut.angle}deg`);
  effect.style.setProperty("--cut-spread", `${cut.spread}px`);
  effect.append(fragment(node, box, style, cut.upper, 0), fragment(node, box, style, cut.lower, 1));
  const stroke = document.createElement("span");
  stroke.className = "paper-stroke";
  effect.append(stroke);
  while (host.childElementCount >= MAX_SLICES) removeSlice(host.firstElementChild);
  host.append(effect);
  lifetimes.set(
    effect,
    setTimeout(() => removeSlice(effect), DURATION_MS),
  );
  return effect;
}

export function pulseCombo(node, combo, reduced = false) {
  if (reduced || !(combo === 3 || combo === 5 || (combo >= 10 && combo % 10 === 0))) return;
  if (typeof node.animate !== "function") return;
  for (const animation of node.getAnimations()) animation.cancel();
  const scale = combo >= 10 ? 1.3 : combo >= 5 ? 1.2 : 1.12;
  node.animate(
    [
      { transform: "scale(1)" },
      { transform: `scale(${scale})`, offset: 0.3 },
      { transform: "scale(1)" },
    ],
    { duration: 180, easing: "ease-out" },
  );
}
