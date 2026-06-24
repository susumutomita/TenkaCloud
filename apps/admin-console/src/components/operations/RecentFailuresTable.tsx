import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import type { RecentFailure } from "../../hooks/useOperationsSnapshot";
import { useT } from "../../i18n";

/**
 * Issue #1770: 直近の provisioning / deprovisioning 失敗テーブル。 OperationsPage から切り出し、
 * Table / cell フォーマット / AWS Console deep link 列を本 module に閉じ込めた。
 *
 * `loaded === false` (= snapshot 未取得) かつ error / forbidden でないときだけ loading 表示にする。
 * 取得後 0 件なら empty メッセージを出す (= snapshot 未取得時は spinner を維持する)。
 */
export function RecentFailuresTable({
  failures,
  loaded,
  error,
  forbidden,
}: {
  failures: readonly RecentFailure[];
  loaded: boolean;
  error: boolean;
  forbidden: boolean;
}) {
  const t = useT();
  return (
    <Table<RecentFailure>
      variant="container"
      header={
        <Header variant="h2" counter={`(${loaded ? failures.length : 0})`}>
          {t("operations.recent_failures_header")}
        </Header>
      }
      items={[...failures]}
      trackBy="rowId"
      loading={!loaded && !error && !forbidden}
      loadingText={t("operations.snapshot_loading")}
      empty={
        !loaded ? (
          <Box textAlign="center" padding="m">
            <Spinner /> {t("operations.snapshot_loading")}
          </Box>
        ) : (
          <Box textAlign="center" color="inherit" padding="xxl">
            {t("operations.recent_failures_empty")}
          </Box>
        )
      }
      columnDefinitions={[
        {
          id: "kind",
          header: t("operations.col_failure_kind"),
          cell: (item) =>
            item.kind === "provisioning"
              ? t("operations.failure_kind_provisioning")
              : t("operations.failure_kind_deprovisioning"),
        },
        {
          id: "id",
          header: t("operations.col_failure_id"),
          cell: (item) => <code>{item.id}</code>,
        },
        {
          id: "status",
          header: t("operations.col_failure_status"),
          cell: (item) => <Badge color="red">{item.status}</Badge>,
        },
        {
          id: "started",
          header: t("operations.col_failure_started"),
          cell: (item) => item.startTimeIso ?? "—",
        },
        {
          id: "updated",
          header: t("operations.col_failure_updated"),
          cell: (item) => item.lastUpdateTimeIso ?? "—",
        },
        {
          id: "console",
          header: t("operations.col_failure_link"),
          cell: (item) => (
            <Link
              external
              href={item.consoleUrl}
              ariaLabel={t("operations.open_failure_console_aria")}
            >
              {t("operations.open_failure_console")}
            </Link>
          ),
        },
      ]}
    />
  );
}
