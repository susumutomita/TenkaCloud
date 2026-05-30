import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CelebrationOverlay } from "../../src/components/CelebrationOverlay";

/**
 * audit table #6: 正解時の confetti 演出。 visible=false は null、 visible=true で 60 粒 +
 * keyframes を描画、 3 秒後に fade-out (null) する 1-shot 挙動を pin する。 外部 lib なしの
 * 自前 CSS animation なので render + fake timer だけで完結する。
 */
afterEach(() => vi.useRealTimers());

describe("CelebrationOverlay", () => {
  it("should render nothing when not visible", () => {
    const { container } = render(<CelebrationOverlay visible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("should render 60 confetti particles + the fall keyframes when visible", () => {
    const { container } = render(<CelebrationOverlay visible />);
    expect(container.querySelectorAll("span")).toHaveLength(60);
    expect(container.querySelector("style")?.textContent).toContain("tc-celebrate-fall");
    // 装飾なので a11y tree からは隠す。
    expect(container.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("should fade out (render null) after the 3s duration", () => {
    vi.useFakeTimers();
    const { container } = render(<CelebrationOverlay visible />);
    expect(container.querySelectorAll("span")).toHaveLength(60);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.firstChild).toBeNull();
  });
});
