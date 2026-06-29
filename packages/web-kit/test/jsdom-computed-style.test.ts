import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
});

describe("jsdom computed style normalization", () => {
  it("should normalize an unresolved auto width to the no-layout fallback", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);

    expect(window.getComputedStyle(element).width).toBe("0px");
  });

  it("should preserve a resolved pixel width", () => {
    const element = document.createElement("div");
    element.style.width = "320px";
    document.body.appendChild(element);

    expect(window.getComputedStyle(element).width).toBe("320px");
  });
});
