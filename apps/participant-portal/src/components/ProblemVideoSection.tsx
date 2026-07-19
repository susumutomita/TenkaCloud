import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useT } from "../i18n";

/**
 * #2707 P0-1: 問題冒頭の 1 分 operation 動画。 同一 origin の自ホスト mp4 に加えて、
 * リポジトリ肥大化を避けるため YouTube の正規 embed URL を扱う。 YouTube は strict allow-list
 * で iframe に限定し、それ以外は従来どおり video として扱う。
 */
function isYouTubeEmbedUrl(videoUrl: string): boolean {
  return /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(videoUrl);
}

export function ProblemVideoSection({ videoUrl }: { videoUrl: string }) {
  const t = useT();
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  const isYouTube = isYouTubeEmbedUrl(videoUrl);
  return (
    <Container header={<Header variant="h2">{t("problem_detail.video_header")}</Header>}>
      <SpaceBetween size="xs">
        {isYouTube ? (
          <iframe
            src={videoUrl}
            title={t("problem_detail.video_header")}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            style={{
              width: "100%",
              maxWidth: 960,
              aspectRatio: "16 / 9",
              display: "block",
              border: 0,
              borderRadius: 8,
            }}
          />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: 字幕は動画へ焼き込み済み (#2707 P1)。
          <video
            controls
            preload="metadata"
            src={videoUrl}
            aria-label={t("problem_detail.video_header")}
            style={{ width: "100%", maxWidth: 960, display: "block", borderRadius: 8 }}
            onError={() => setUnavailable(true)}
          />
        )}
        <Box variant="small">
          {t(isYouTube ? "problem_detail.video_note_youtube" : "problem_detail.video_note")}
        </Box>
      </SpaceBetween>
    </Container>
  );
}
