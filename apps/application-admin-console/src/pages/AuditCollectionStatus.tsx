import Alert from "@cloudscape-design/components/alert";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { HostAuditCollection } from "../api/audit-log-client";

export function AuditCollectionStatus({
  collection,
  lang,
}: {
  collection: HostAuditCollection;
  lang: string;
}) {
  const ja = lang === "ja";
  const enabledHeader = ja ? "記録中" : "Recording enabled";
  const stoppedHeader = ja ? "記録を停止しています" : "Recording stopped";
  return (
    <SpaceBetween size="s">
      <Alert
        type={collection.enabled ? "info" : "warning"}
        header={collection.enabled ? enabledHeader : stoppedHeader}
      >
        {ja
          ? `直近${collection.retentionDays}日・最大${collection.maxRows.toLocaleString()}件を保持します。停止中の操作は後から記録されません。記録がないことは、操作がなかったことを意味しません。CSVは保持中の記録を最大5,000件まで出力します。`
          : `Records are retained for ${collection.retentionDays} days, up to ${collection.maxRows.toLocaleString()} entries. Operations while recording is stopped are not collected later. No record does not mean no operation occurred. CSV exports contain up to 5,000 retained entries.`}
      </Alert>
      {collection.missed > 0 && (
        <Alert
          type="error"
          header={ja ? "監査記録の欠落があります" : "Some audit records are missing"}
        >
          {ja
            ? `${collection.missed}件の記録に失敗しました。受理済みの処理は実行記録で確認してください。`
            : `${collection.missed} audit records could not be saved. Check the execution records for accepted operations.`}
          {!collection.gapStatusDurable &&
            (ja
              ? " 欠落数は現在のプロセスで保持中です。"
              : " The missing-record count is currently held by this process.")}
        </Alert>
      )}
      {collection.discarded > 0 && (
        <Alert type="info">
          {ja
            ? `保存期限または件数上限により、${collection.discarded.toLocaleString()}件の古い記録を削除しました。`
            : `${collection.discarded.toLocaleString()} old records were removed by the retention limits.`}
        </Alert>
      )}
    </SpaceBetween>
  );
}
