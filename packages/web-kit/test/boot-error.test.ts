import { describe, expect, it } from "vitest";
import { renderBootError } from "../src/boot-error";

describe("renderBootError", () => {
  it("should render the boot error message as text", () => {
    const root = document.createElement("div");

    renderBootError(root, new Error("<img src=x onerror=alert(1)>"));

    const pre = root.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("Config load failed: <img src=x onerror=alert(1)>");
    expect(root.querySelector("img")).toBeNull();
  });

  it("should clamp long boot error details", () => {
    const root = document.createElement("div");
    const message = "x".repeat(400);

    renderBootError(root, new Error(message));

    expect(root.textContent).toMatch(/^Config load failed: x+/);
    expect(root.textContent?.length).toBeLessThan(message.length);
    expect(root.textContent).toContain("...");
  });

  it("should render an unknown fallback for empty error messages", () => {
    const root = document.createElement("div");

    renderBootError(root, new Error(""));

    expect(root.textContent).toBe("Config load failed: Unknown error");
  });

  it("should render an unknown fallback for blank error details", () => {
    const root = document.createElement("div");

    renderBootError(root, "   ");

    expect(root.textContent).toBe("Config load failed: Unknown error");
  });

  it("should render an unknown fallback for unstringifiable values", () => {
    const root = document.createElement("div");
    const error = {
      [Symbol.toPrimitive]() {
        throw new Error("cannot stringify");
      },
    };

    renderBootError(root, error);

    expect(root.textContent).toBe("Config load failed: Unknown error");
  });

  it("should replace any existing boot content", () => {
    const root = document.createElement("div");
    root.append(document.createElement("span"));

    renderBootError(root, "plain failure");

    expect(root.children).toHaveLength(1);
    expect(root.textContent).toBe("Config load failed: plain failure");
  });
});
