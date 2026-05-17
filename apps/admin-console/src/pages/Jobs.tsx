import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import Tabs from "@cloudscape-design/components/tabs";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminInsightApiError,
  fetchPipelineExecutions,
  fetchStateMachineExecutions,
  type PipelineExecutionItem,
  type StateMachineExecutionItem,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { interpolate, useT } from "../i18n";

/**
 * Issue #658: admin-console の Tenant Provisioning Jobs 一覧 page。
 *
 * `tenkacloud-saas-pipeline` (= ServerlessSaaSPipeline) の execution 履歴を 60s polling で
 * fetch し、 各 execution の status / 経過時間 / AWS console deep link を表示する。
 *
 * Phase 1: 全 execution を flat 表示。 Phase 2 (= 別 PR) で status filter / tenant 紐付け /
 * Failed phase 詳細を追加予定。
 */

const POLL_INTERVAL_MS = 60_000;
const PAGE_SIZE = 50;

const STATUS_COLOR: Record<string, "blue" | "green" | "grey" | "red"> = {
  InProgress: "blue",
  Running: "blue",
  Succeeded: "green",
  Failed: "red",
  Cancelled: "grey",
  Stopped: "grey",
  Stopping: "grey",
  Superseded: "grey",
};

function colorFor(status: string): "blue" | "green" | "grey" | "red" {
  return STATUS_COLOR[status] ?? "grey";
}

function formatElapsed(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso) return "—";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  const end = endIso ? Date.parse(endIso) : Date.now();
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function JobsPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const [items, setItems] = useState<readonly PipelineExecutionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;

  const fetchOnce = useCallback(async () => {
    if (!idToken) return;
    try {
      const res = await fetchPipelineExecutions(config, idToken, { limit: PAGE_SIZE });
      if (res === null) {
        setNotConfigured(true);
        return;
      }
      setItems(res.items);
      setError(null);
      setForbidden(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [config, idToken]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchOnce();
    };
    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [fetchOnce]);

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
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {items === null && !error ? (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("jobs_page.loading")}
        </Box>
      ) : (
        <Table<PipelineExecutionItem>
          variant="embedded"
          items={[...(items ?? [])]}
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
 * legacy placeholder にフォールバック。
 */
function DeprovisioningJobsTab({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const [items, setItems] = useState<readonly StateMachineExecutionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;
  const region = config.awsRegion || "ap-northeast-1";

  const fetchOnce = useCallback(async () => {
    if (!idToken) return;
    try {
      const res = await fetchStateMachineExecutions(config, idToken, { limit: PAGE_SIZE });
      if (res === null) {
        setNotConfigured(true);
        setItems([]);
        return;
      }
      setItems(res.items);
      setError(null);
      setForbidden(false);
      setNotConfigured(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN) {
        setForbidden(true);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config, idToken]);

  useEffect(() => {
    if (!idToken) return;
    void fetchOnce();
    const interval = setInterval(() => void fetchOnce(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchOnce, idToken]);

  const sfnListUrl = useMemo(
    () => `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines`,
    [region],
  );

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
      <Table
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
