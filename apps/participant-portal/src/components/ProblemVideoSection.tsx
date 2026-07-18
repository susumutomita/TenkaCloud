import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useT } from "../i18n";

/**
 * #2707 P0-1: 問題冒頭の 1 分 operation 動画。 同一 origin の自ホスト mp4 のみを想定する
 * (landing の CSP は外部埋め込みを禁止)。 字幕は ja / en 併記で動画に焼き込み済みなので
 * locale ごとの URL 切り替えは不要。 読み込めない環境 (`make dev` の SPA 単独配信など) では
 * section ごと消えて問題は成立し続ける (#2707 受け入れ条件「非表示環境でも問題は成立する」)。
 */
export function ProblemVideoSection({ videoUrl }: { videoUrl: string }) {
  const t = useT();
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  return (
    <Container header={<Header variant="h2">{t("problem_detail.video_header")}</Header>}>
      <SpaceBetween size="xs">
        {/* biome-ignore lint/a11y/useMediaCaption: 字幕は動画へ焼き込み済み (音声なし、 #2707 P1)。 */}
        <video
          controls
          preload="metadata"
          src={videoUrl}
          aria-label={t("problem_detail.video_header")}
          style={{ width: "100%", maxWidth: 960, display: "block", borderRadius: 8 }}
          onError={() => setUnavailable(true)}
        />
        <Box variant="small">{t("problem_detail.video_note")}</Box>
      </SpaceBetween>
    </Container>
  );
}
