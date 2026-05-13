import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminInsightApiError,
  fetchPipelineExecutions,
  type PipelineExecutionItem,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

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
        header: "Execution ID",
        cell: (item: PipelineExecutionItem) => (
          <Button
            variant="inline-link"
            href={item.consoleUrl}
            target="_blank"
            ariaLabel={`Open execution ${item.executionId} in AWS Console`}
          >
            <code>{item.executionId.slice(0, 12)}…</code> ↗
          </Button>
        ),
      },
      {
        id: "status",
        header: "状態",
        cell: (item: PipelineExecutionItem) => (
          <Badge color={colorFor(item.status)}>{item.status}</Badge>
        ),
      },
      {
        id: "startTime",
        header: "開始時刻",
        cell: (item: PipelineExecutionItem) => item.startTimeIso ?? "—",
      },
      {
        id: "elapsed",
        header: "経過時間",
        cell: (item: PipelineExecutionItem) =>
          formatElapsed(item.startTimeIso, item.lastUpdateTimeIso),
      },
      {
        id: "lastUpdate",
        header: "最終更新",
        cell: (item: PipelineExecutionItem) => item.lastUpdateTimeIso ?? "—",
      },
    ],
    [],
  );

  if (notConfigured) {
    return (
      <Alert type="info" header="AdminInsight API が未配線です">
        本環境では admin-insight API URL が runtime-config に設定されていません。Phase 2 deploy
        を完了してください。
      </Alert>
    );
  }

  if (forbidden) {
    return (
      <Alert type="error" header="権限がありません">
        この機能は SystemAdmin group のメンバーのみ閲覧できます。ログインし直してください。
      </Alert>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="tenkacloud-saas-pipeline の最近 50 件の execution。60 秒ごとに自動更新します。"
      >
        Provisioning Jobs
      </Header>

      {error && (
        <Alert
          type="error"
          header="読み込みに失敗しました"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {items === null && !error ? (
        <Box textAlign="center" padding="l">
          <Spinner /> 読み込み中…
        </Box>
      ) : (
        <Table<PipelineExecutionItem>
          variant="container"
          items={[...(items ?? [])]}
          trackBy="executionId"
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              Pipeline execution の履歴がありません。tenant をまだ作成していない可能性があります。
            </Box>
          }
          columnDefinitions={columns}
        />
      )}
    </SpaceBetween>
  );
}
