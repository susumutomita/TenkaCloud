/**
 * jsdom has no layout engine. Since jsdom 29, `getComputedStyle(element).width`
 * preserves the CSS value `auto`; browsers return a resolved pixel width instead.
 * Cloudscape's responsive components parse that width and treat `NaN` as an
 * undersized container, which collapses every TopNavigation utility in tests.
 *
 * Normalize unresolved widths to zero, matching the no-layout behavior that
 * Cloudscape already handles as its SSR/test fallback.
 */
const nativeGetComputedStyle = window.getComputedStyle.bind(window);

Object.defineProperty(window, "getComputedStyle", {
  configurable: true,
  value: (element: Element, pseudoElement?: string | null): CSSStyleDeclaration => {
    const style = nativeGetComputedStyle(element, pseudoElement);
    if (style.width === "auto") {
      Object.defineProperty(style, "width", {
        configurable: true,
        value: "0px",
      });
    }
    return style;
  },
});
