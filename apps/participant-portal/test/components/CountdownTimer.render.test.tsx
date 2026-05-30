import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1349: CountdownTimer の render 分岐 (no-event / ended / warning / running) と
 * 1 秒 tick の interval を pin する。 純粋ロジック computeCountdownState は別 test で網羅済。
 * useT は key を echo する mock に差し替えて Cloudscape Badge のラベルを照合する。
 */
vi.mock("../../src/i18n", () => ({ useT: () => (key: string) => key }));

const { CountdownTimer } = await import("../../src/components/CountdownTimer");

const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CountdownTimer (render)", () => {
  it("should render nothing when endsAt is absent", () => {
    const { container } = render(<CountdownTimer />);
    expect(container.textContent).toBe("");
  });

  it("should show the ended label once the event has ended", () => {
    const { container } = render(<CountdownTimer endsAt={isoIn(-1000)} />);
    expect(container.textContent).toContain("countdown.ended_label");
  });

  it("should show the last-5-minutes warning label within the threshold", () => {
    const { container } = render(<CountdownTimer endsAt={isoIn(2 * 60 * 1000)} />);
    expect(container.textContent).toContain("countdown.last_5_min");
  });

  it("should show the running label well before the deadline", () => {
    const { container } = render(<CountdownTimer endsAt={isoIn(2 * 60 * 60 * 1000)} />);
    expect(container.textContent).toContain("countdown.remaining_label");
  });

  it("should re-render on the 1-second interval tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:00:00.000Z"));
    const endsAt = new Date("2026-05-05T10:02:00.000Z").toISOString(); // warning 圏内
    const { container } = render(<CountdownTimer endsAt={endsAt} />);
    expect(container.textContent).toContain("00:02:00");
    // interval callback (setInterval → setNowMs) を 1 tick 進める。 state 更新を act で flush。
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toContain("00:01:59");
  });
});
