import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Tabs from "@cloudscape-design/components/tabs";
import { useMemo } from "react";
import type { PipelineExecutionItem, StateMachineExecutionItem } from "../api/admin-drill-down";
import { JobsTable } from "../components/JobsTable";
import type { AppConfig } from "../config";
import { useDeprovisioningJobs } from "../hooks/useDeprovisioningJobs";
import { useProvisioningJobs } from "../hooks/useProvisioningJobs";
import { interpolate, useT } from "../i18n";
import { colorFor, formatElapsed } from "../lib/jobs-format";

/**
 * Issue #658: admin-console の Tenant Provisioning Jobs 一覧 page。
 *
 * `tenkacloud-saas-pipeline` (= ServerlessSaaSPipeline) の execution 履歴を 60s polling で
 * fetch し、 各 execution の status / 経過時間 / AWS console deep link を表示する。 fetch /
 * polling / 状態管理は `useProvisioningJobs` / `useDeprovisioningJobs` hook、 表は `JobsTable`、
 * 表示加工は `lib/jobs-format` に分離し、 本 page は両タブを束ねる thin orchestrator (#refactor)。
 */

// 表示加工 helper は lib/jobs-format に移設 (#refactor)。 既存 import 互換のため re-export。
export { colorFor, formatElapsed } from "../lib/jobs-format";

export function JobsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const { items, error, forbidden, notConfigured, dismissError } = useProvisioningJobs(config);

  const columns = useMemo(
    () => [
      {
        id: "executionId",
        header: t("jobs_page.col_execution_id"),
        cell: (item: PipelineExecutionItem) => (
          <Button
            variant="inline-link"
            href={item.consoleUrl}
            target="_blank"
            ariaLabel={interpolate(t("jobs_page.open_console_aria"), {
              executionId: item.executionId,
            })}
          >
            <code>{item.executionId.slice(0, 12)}…</code> ↗
          </Button>
        ),
      },
      {
        id: "status",
        header: t("jobs_page.col_status"),
        cell: (item: PipelineExecutionItem) => (
          <Badge color={colorFor(item.status)}>{item.status}</Badge>
        ),
      },
      {
        id: "startTime",
        header: t("jobs_page.col_start_time"),
        cell: (item: PipelineExecutionItem) => item.startTimeIso ?? "—",
      },
      {
        id: "elapsed",
        header: t("jobs_page.col_elapsed"),
        cell: (item: PipelineExecutionItem) =>
          formatElapsed(item.startTimeIso, item.lastUpdateTimeIso),
      },
      {
        id: "lastUpdate",
        header: t("jobs_page.col_last_update"),
        cell: (item: PipelineExecutionItem) => item.lastUpdateTimeIso ?? "—",
      },
    ],
    [t],
  );

  if (notConfigured) {
    return (
      <Alert type="info" header={t("jobs_page.not_configured_header")}>
        {t("jobs_page.not_configured_body")}
      </Alert>
    );
  }

  if (forbidden) {
    return (
      <Alert type="error" header={t("jobs_page.forbidden_header")}>
        {t("jobs_page.forbidden_body")}
      </Alert>
    );
  }

  const provisioningContent = (
    <SpaceBetween size="m">
      {error && (
        <Alert
          type="error"
          header={t("jobs_page.error_header")}
          dismissible
          onDismiss={dismissError}
        >
          {error}
        </Alert>
      )}

      {items === null && !error ? (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("jobs_page.loading")}
        </Box>
      ) : (
        <JobsTable<PipelineExecutionItem>
          variant="embedded"
          items={items ?? []}
          trackBy="executionId"
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              {t("jobs_page.empty")}
            </Box>
          }
          columnDefinitions={columns}
        />
      )}
    </SpaceBetween>
  );

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("jobs_page.description")}>
        {t("jobs_page.header")}
      </Header>

      <Tabs
        tabs={[
          {
            id: "provisioning",
            label: t("jobs_page.tab_provisioning"),
            content: provisioningContent,
          },
          {
            id: "deprovisioning",
            label: t("jobs_page.tab_deprovisioning"),
            content: <DeprovisioningJobsTab config={config} />,
          },
        ]}
      />
    </SpaceBetween>
  );
}

/**
 * Issue #814 Phase 2: Deprovisioning Jobs (= SBT BashJobRunner の `deprovisioningJobRunner` が動かす
 * Step Functions State Machine の execution 履歴) を表示するタブ。
 *
 * admin-insight Lambda が \`GET /admin/insight/state-machine-executions\` で
 * deprovisioning SM の ListExecutions を返す。 503 (= not_configured、 旧 stack 互換) は
 * legacy placeholder にフォールバック。 fetch / polling / 状態管理は `useDeprovisioningJobs` hook。
 */
export function DeprovisioningJobsTab({ config }: { config: AppConfig }) {
  const t = useT();
  const { items, error, forbidden, notConfigured, sfnListUrl } = useDeprovisioningJobs(config);

  if (notConfigured) {
    return (
      <SpaceBetween size="m">
        <Alert type="info" header={t("jobs_page.deprovisioning_phase1_header")}>
          {t("jobs_page.deprovisioning_phase1_body")}
        </Alert>
        <Box>
          <Link
            external
            href={sfnListUrl}
            ariaLabel={t("jobs_page.deprovisioning_open_console_aria")}
          >
            {t("jobs_page.deprovisioning_open_console")}
          </Link>
        </Box>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="m">
      {forbidden && (
        <Alert type="error" header={t("jobs_page.forbidden_header")}>
          {t("jobs_page.forbidden_body")}
        </Alert>
      )}
      {error && !forbidden && (
        <Alert type="error" header={t("jobs_page.fetch_failed_header")}>
          {error}
        </Alert>
      )}
      <JobsTable<StateMachineExecutionItem>
        items={items ?? []}
        loading={items === null && !forbidden && !error}
        loadingText={t("jobs_page.loading")}
        columnDefinitions={[
          {
            id: "name",
            header: t("jobs_page.col_execution_id"),
            cell: (e) => (
              <Link external href={e.consoleUrl}>
                <code>{e.name}</code>
              </Link>
            ),
          },
          {
            id: "status",
            header: t("jobs_page.col_status"),
            cell: (e) => <Badge color={colorFor(e.status)}>{e.status}</Badge>,
          },
          {
            id: "started",
            header: t("jobs_page.col_started"),
            cell: (e) => e.startTimeIso ?? "—",
          },
          {
            id: "elapsed",
            header: t("jobs_page.col_elapsed"),
            cell: (e) => formatElapsed(e.startTimeIso, e.stopTimeIso),
          },
        ]}
        empty={
          items && items.length === 0 ? (
            <Box textAlign="center" padding="m">
              <Box variant="strong">{t("jobs_page.empty_deprovisioning")}</Box>
            </Box>
          ) : (
            <Spinner />
          )
        }
      />
    </SpaceBetween>
  );
}
