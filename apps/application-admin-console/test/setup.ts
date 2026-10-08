import "@testing-library/jest-dom/vitest";
import "../../../packages/web-kit/test/jsdom-computed-style";

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, value),
  };
}

if (
  typeof window !== "undefined" &&
  (window.localStorage === undefined || typeof window.localStorage.clear !== "function")
) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}

// jsdom does not implement layout observers; browser tests verify actual scroll edges.
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {
      /* no layout in jsdom */
    }
    unobserve() {
      /* no layout in jsdom */
    }
    disconnect() {
      /* no observers allocated */
    }
  };
}
