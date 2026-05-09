import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type NavigateFunction, useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { type EventStatus, type EventSummary, listEvents } from "../api/events-client";
import type { AppConfig } from "../config";

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

const POLL_INTERVAL_MS = 10_000;
const PAGE_SIZE = 50;

function buildColumns(navigate: NavigateFunction): TableProps.ColumnDefinition<EventSummary>[] {
  return [
    {
      id: "name",
      header: "Event 名",
      cell: (item) => (
        <Link
          fontSize="body-m"
          href={`/events/${encodeURIComponent(item.eventId)}`}
          onFollow={(e) => {
            e.preventDefault();
            navigate(`/events/${encodeURIComponent(item.eventId)}`);
          }}
        >
          {item.name}
        </Link>
      ),
    },
    {
      id: "status",
      header: "ステータス",
      cell: (item) => <Badge color={STATUS_COLOR[item.status]}>{item.status}</Badge>,
    },
    { id: "teamCount", header: "チーム数", cell: (item) => item.teamCount },
    { id: "problemCount", header: "問題数", cell: (item) => item.problemCount },
    { id: "createdAt", header: "作成", cell: (item) => item.createdAt },
  ];
}

export function EventListPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const columns = useMemo(() => buildColumns(navigate), [navigate]);

  const fetchOnce = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listEvents(apiClient, { limit: PAGE_SIZE });
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiClient]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchOnce();
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce]);

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 読み込み中…
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="競技イベント (Event) 一覧。1 event = N teams × M problems を一括 deploy / teardown できます。"
        actions={
          <Button variant="primary" onClick={() => navigate("/events/new")}>
            新規 Event 作成
          </Button>
        }
      >
        Event 一覧
      </Header>

      {error && (
        <Alert type="error" header="一覧の取得に失敗しました">
          {error}
        </Alert>
      )}

      <Table
        items={items ?? []}
        columnDefinitions={columns}
        loadingText="読み込み中"
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            まだ Event はありません。「新規 Event 作成」から始めてください。
          </Box>
        }
      />
    </SpaceBetween>
  );
}
