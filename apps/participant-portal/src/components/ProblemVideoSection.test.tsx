import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProblemVideoSection } from "./ProblemVideoSection";

/**
 * #2707 P0-1: 問題冒頭の 1 分 operation 動画 section。 自ホスト動画が読み込めない環境では
 * section ごと消えて問題本文だけで成立する (受け入れ条件「非表示環境でも問題は成立する」)。
 */

vi.mock("../i18n", () => ({
  useT: () => (key: string) => key,
}));

describe("ProblemVideoSection", () => {
  it("should render a same-origin video with controls and a no-audio note", () => {
    const { container } = render(
      <ProblemVideoSection videoUrl="/videos/onboarding/understand-tenkacloud.mp4" />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("/videos/onboarding/understand-tenkacloud.mp4");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(screen.getByText("problem_detail.video_header")).toBeDefined();
    expect(screen.getByText("problem_detail.video_note")).toBeDefined();
  });

  it("should remove the whole section when the video fails to load", () => {
    const { container } = render(<ProblemVideoSection videoUrl="/videos/onboarding/missing.mp4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    if (!video) throw new Error("unreachable");
    fireEvent.error(video);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByText("problem_detail.video_header")).toBeNull();
  });
});
