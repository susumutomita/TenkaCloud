import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useT } from "../i18n";
import { CopyableField } from "./CopyableField";

/**
 * Issue #2696: Lite deploy オンボーディングドリルのチェックポイント表示。
 *
 * Lite mode の console でオンボーディングのマイルストーン (Competitor アカウント検証 /
 * 初回イベント作成) に到達した瞬間、 LP デモポータルのドリルに提出できるコードを
 * その場で見せる。 表示可否 (= Lite かどうか) は caller が `liteDrillCheckpointCode`
 * で判定し、 本 component はコードを受け取って描画するだけ。
 */
export function LiteDrillCheckpointAlert({
  code,
  onDismiss,
}: {
  code: string;
  onDismiss?: () => void;
}) {
  const t = useT();
  return (
    <Alert
      type="success"
      header={t("lite_drill.checkpoint_header")}
      {...(onDismiss ? { dismissible: true, onDismiss } : {})}
    >
      <SpaceBetween size="xs">
        <CopyableField value={code} ariaLabel={t("lite_drill.copy_aria")} />
        <Box variant="small">{t("lite_drill.checkpoint_body")}</Box>
      </SpaceBetween>
    </Alert>
  );
}
