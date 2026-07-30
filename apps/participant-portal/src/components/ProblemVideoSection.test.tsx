import { readFileSync } from "node:fs";
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
  it("should keep the video before the problem and scoring panel on the detail page", () => {
    const detailSource = readFileSync("src/pages/ProblemDetail.tsx", "utf8");
    const videoIndex = detailSource.indexOf("<PlacedProblemVideo");
    const panelIndex = detailSource.indexOf("<ProblemPanel");
    expect(videoIndex).toBeGreaterThan(-1);
    expect(panelIndex).toBeGreaterThan(videoIndex);
  });

  it("should render a same-origin video with controls and a baked-caption note", () => {
    const { container } = render(<ProblemVideoSection videoUrl="/videos/onboarding/example.mp4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("/videos/onboarding/example.mp4");
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

  it("should render an allow-listed YouTube embed without falling back to a video element", () => {
    const { container } = render(
      <ProblemVideoSection videoUrl="https://www.youtube.com/embed/nLsSJ3npdfw" />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("https://www.youtube.com/embed/nLsSJ3npdfw");
    expect(iframe?.hasAttribute("allowfullscreen")).toBe(true);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("problem_detail.video_note_youtube")).toBeDefined();
  });

  it("should not iframe a non-allow-listed external URL", () => {
    const { container } = render(
      <ProblemVideoSection videoUrl="https://example.com/embed/nLsSJ3npdfw" />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "https://example.com/embed/nLsSJ3npdfw",
    );
  });
});
