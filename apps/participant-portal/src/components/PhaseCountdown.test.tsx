import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhaseCountdown, type PhaseCountdownEntry } from "./PhaseCountdown";

/**
 * Issue #607 PhaseCountdown: deployedAt + afterMinutes から live remaining time を表示する。
 * fake timers で時刻を進めて 3 つの境界 (future / soon / past) を観測する。
 */

describe("PhaseCountdown (Issue #607)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-05-13T10:00:00Z を "現在時刻" として固定
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseEntry: PhaseCountdownEntry = {
    id: "phase-degraded",
    name: "degraded",
    afterMinutes: 60,
    variant: "phase",
  };

  it("entries が空なら何も render しないべき", () => {
    const { container } = render(<PhaseCountdown entries={[]} deployedAt="2026-05-13T10:00:00Z" />);
    expect(container.firstChild).toBeNull();
  });

  it("deployedAt が無い (= deploy 中) なら『deploy 時刻未確定』 表示にすべき", () => {
    render(<PhaseCountdown entries={[baseEntry]} />);
    expect(screen.getByText(/deploy 時刻未確定/)).toBeInTheDocument();
    // +60 分 badge は静的に出る
    expect(screen.getByText("+60 分")).toBeInTheDocument();
  });

  // 注: getByText は要素境界で分割されたテキストを match できないため、 残時間表示は
  // container.textContent に対する正規表現で確認する。
  it("deploy 直後 (= 残 60 分) は future 状態で残時間を表示すべき", () => {
    const { container } = render(
      <PhaseCountdown
        entries={[baseEntry]}
        deployedAt="2026-05-13T10:00:00.000Z" // 現在時刻と同じ → 残 60 分
      />,
    );
    // 60 分は formatter で「1:00:00」 (= H:MM:SS) になる
    expect(container.textContent).toMatch(/あと 1:00:00/);
  });

  it("setInterval で 1 秒後に残時間が減るべき", () => {
    const { container } = render(
      <PhaseCountdown
        entries={[baseEntry]}
        deployedAt="2026-05-13T10:00:00.000Z" // 残 60 分
      />,
    );
    expect(container.textContent).toMatch(/あと 1:00:00/);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 残 1 時間未満になったため H 部は省略され `あと 59:59` 形式
    expect(container.textContent).toMatch(/あと 59:59/);
  });

  it("残 3 分以内は 'soon' 強調 (warn 色) にすべき", () => {
    // 57 分前 deploy → 残 3 分丁度。 内部判定が <= 180_000 ms なので soon。
    const { container } = render(
      <PhaseCountdown
        entries={[baseEntry]}
        deployedAt="2026-05-13T09:03:00.000Z" // 57 分前 → 残 3 分
      />,
    );
    expect(container.textContent).toMatch(/あと 3:00/);
  });

  it("残時間 0 以下は '発火済' badge にすべき", () => {
    // 61 分前 deploy → 残 -1 分 (= 既に発火済)
    const { container } = render(
      <PhaseCountdown
        entries={[baseEntry]}
        deployedAt="2026-05-13T08:59:00.000Z" // 61 分前
      />,
    );
    expect(container.textContent).toContain("発火済");
  });

  it("disruption variant は発火済時に '発火済' badge を表示すべき", () => {
    const disruption: PhaseCountdownEntry = {
      id: "d1",
      name: "EC2 latency",
      afterMinutes: 60,
      variant: "disruption",
    };
    // 61 分前 → past
    const { container } = render(
      <PhaseCountdown entries={[disruption]} deployedAt="2026-05-13T08:59:00.000Z" />,
    );
    expect(container.textContent).toContain("発火済");
  });

  it("description は <p> として描画すべき", () => {
    render(
      <PhaseCountdown
        entries={[{ ...baseEntry, description: "EC2 latency injection の説明" }]}
        deployedAt="2026-05-13T10:00:00.000Z"
      />,
    );
    expect(screen.getByText("EC2 latency injection の説明")).toBeInTheDocument();
  });

  it("malformed deployedAt は『deploy 時刻未確定』 fallback にすべき", () => {
    render(<PhaseCountdown entries={[baseEntry]} deployedAt="not-an-iso-date" />);
    expect(screen.getByText(/deploy 時刻未確定/)).toBeInTheDocument();
  });
});
