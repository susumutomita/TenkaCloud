import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useT } from "../i18n";

/**
 * #2707 P0-1: 問題冒頭の短い operation 動画。 同一 origin の自ホスト mp4 に加えて、
 * リポジトリ肥大化を避けるため YouTube の正規 embed URL を扱う。 YouTube は strict allow-list
 * で iframe に限定し、それ以外は従来どおり video として扱う。
 */
function isYouTubeEmbedUrl(videoUrl: string): boolean {
  return /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(videoUrl);
}

function liteCaptionStem(videoUrl: string): string | undefined {
  const match = videoUrl.match(
    /^(\/videos\/onboarding\/(?:deploy|cleanup)-tenkacloud-lite)(?:\.en)?\.mp4$/,
  );
  return match?.[1];
}

export function ProblemVideoSection({ videoUrl }: { videoUrl: string }) {
  const t = useT();
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  const isYouTube = isYouTubeEmbedUrl(videoUrl);
  const captionStem = liteCaptionStem(videoUrl);
  const englishVideo = videoUrl.endsWith(".en.mp4");
  const noteKey = isYouTube
    ? "problem_detail.video_note_youtube"
    : captionStem
      ? "problem_detail.video_note_voicevox"
      : "problem_detail.video_note";
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
          // biome-ignore lint/a11y/useMediaCaption: 音声付き Lite 動画には直下で日英 WebVTT track を付ける。旧動画は無音・字幕焼き込み済み。
          <video
            controls
            preload="metadata"
            src={videoUrl}
            aria-label={t("problem_detail.video_header")}
            style={{ width: "100%", maxWidth: 960, display: "block", borderRadius: 8 }}
            onError={() => setUnavailable(true)}
          >
            {captionStem && (
              <>
                <track
                  default={!englishVideo}
                  kind="captions"
                  src={`${captionStem}.ja.vtt`}
                  srcLang="ja"
                  label="日本語"
                />
                <track
                  default={englishVideo}
                  kind="captions"
                  src={`${captionStem}.en.vtt`}
                  srcLang="en"
                  label="English"
                />
              </>
            )}
          </video>
        )}
        <Box variant="small">{t(noteKey)}</Box>
      </SpaceBetween>
    </Container>
  );
}
