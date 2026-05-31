import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";

/**
 * Issue #1366: 共有 loading state。 DESIGN-SYSTEM.html "10. Loading / skeleton pattern" の正本。
 *
 * - 初期 load (= まだ data が一切無い) のときに使う。 polling refresh では既存 data を残して
 *   別 UI (= manual-refresh ボタン横のスピナー) で示すこと。
 * - label は default "Loading..." を出すが、 buyer 視点で 「何を待っているのか」 を明示する
 *   ために caller 側で具体化する (例: 「テナント一覧を取得しています」)。
 * - 3 SPA copy-paste 維持。
 */
export interface LoadingStateProps {
  readonly label?: string;
  readonly textAlign?: "left" | "center";
  readonly padding?: "s" | "m" | "l" | "xl";
}

export function LoadingState({
  label = "Loading...",
  textAlign = "center",
  padding = "l",
}: LoadingStateProps) {
  return (
    <Box textAlign={textAlign} padding={padding} color="inherit">
      <Spinner /> {label}
    </Box>
  );
}
