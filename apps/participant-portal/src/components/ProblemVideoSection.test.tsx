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
  it("should render the Lite video with localized caption tracks", () => {
    const { container } = render(
      <ProblemVideoSection videoUrl="/videos/onboarding/deploy-tenkacloud-lite.mp4" />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("/videos/onboarding/deploy-tenkacloud-lite.mp4");
    expect(video?.hasAttribute("controls")).toBe(true);
    const tracks = [...container.querySelectorAll("track")];
    expect(tracks.map((track) => track.getAttribute("src"))).toEqual([
      "/videos/onboarding/deploy-tenkacloud-lite.ja.vtt",
      "/videos/onboarding/deploy-tenkacloud-lite.en.vtt",
    ]);
    expect(tracks[0]?.hasAttribute("default")).toBe(true);
    expect(tracks[1]?.hasAttribute("default")).toBe(false);
    expect(screen.getByText("problem_detail.video_header")).toBeDefined();
    expect(screen.getByText("problem_detail.video_note_voicevox")).toBeDefined();
  });

  it("should default to English captions for the English video", () => {
    const { container } = render(
      <ProblemVideoSection videoUrl="/videos/onboarding/cleanup-tenkacloud-lite.en.mp4" />,
    );
    const tracks = [...container.querySelectorAll("track")];
    expect(tracks[0]?.hasAttribute("default")).toBe(false);
    expect(tracks[1]?.hasAttribute("default")).toBe(true);
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

  it("should keep the legacy baked-caption note for other self-hosted videos", () => {
    render(<ProblemVideoSection videoUrl="/videos/onboarding/understand-tenkacloud.mp4" />);
    expect(screen.getByText("problem_detail.video_note")).toBeDefined();
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
