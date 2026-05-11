import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type NavigateFunction, useNavigate } from "react-router";
import { type ApiClient, ApiError, useApiClient } from "../api/client";
import {
  archiveEvent,
  type EventStatus,
  type EventSummary,
  listEvents,
} from "../api/events-client";
import type { AppConfig } from "../config";

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

/** Archive 操作が許可される Event status (backend の archive.ts と一致)。 */
const ARCHIVABLE_STATUSES: ReadonlySet<EventStatus> = new Set(["DRAFT", "ENDED", "TEARDOWN"]);

const POLL_INTERVAL_MS = 10_000;
const PAGE_SIZE = 50;

interface ColumnContext {
  navigate: NavigateFunction;
  onArchiveClick: (item: EventSummary) => void;
  archivingId: string | null;
}

function buildColumns(ctx: ColumnContext): TableProps.ColumnDefinition<EventSummary>[] {
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
            ctx.navigate(`/events/${encodeURIComponent(item.eventId)}`);
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
    {
      id: "actions",
      header: "操作",
      cell: (item) => (
        <Button
          variant="link"
          loading={ctx.archivingId === item.eventId}
          disabled={!ARCHIVABLE_STATUSES.has(item.status)}
          onClick={() => ctx.onArchiveClick(item)}
          ariaLabel={`Event ${item.name} をアーカイブ`}
        >
          アーカイブ
        </Button>
      ),
    },
  ];
}

export function EventListPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<EventSummary | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

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

  const visible = useMemo(() => {
    if (!items) return [];
    return showArchived ? items : items.filter((i) => i.status !== "ARCHIVED");
  }, [items, showArchived]);

  const archivedCount = useMemo(
    () => items?.filter((i) => i.status === "ARCHIVED").length ?? 0,
    [items],
  );

  const onArchiveClick = useCallback((item: EventSummary) => {
    setArchiveTarget(item);
  }, []);

  const handleArchiveConfirm = async () => {
    if (!apiClient || !archiveTarget) return;
    const target = archiveTarget;
    setArchivingId(target.eventId);
    setArchiveTarget(null);
    setError(null);
    try {
      await archive(apiClient, target.eventId);
      await fetchOnce();
    } catch (err) {
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        const match = err.message.match(/"currentStatus"\s*:\s*"([A-Z_]+)"/);
        const current = match?.[1];
        setError(
          current
            ? `Event "${target.name}" はアーカイブできません (現在: ${current}、許可: DRAFT / ENDED / TEARDOWN)`
            : `Event "${target.name}" はアーカイブできません`,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setArchivingId(null);
    }
  };

  const columns = useMemo(
    () => buildColumns({ navigate, onArchiveClick, archivingId }),
    [navigate, onArchiveClick, archivingId],
  );

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
        <Alert type="error" header="エラー" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {archivedCount > 0 && (
        <Checkbox checked={showArchived} onChange={({ detail }) => setShowArchived(detail.checked)}>
          アーカイブ済 ({archivedCount}) も表示
        </Checkbox>
      )}

      <Table
        items={visible}
        columnDefinitions={columns}
        loadingText="読み込み中"
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {showArchived
              ? "まだ Event はありません。「新規 Event 作成」から始めてください。"
              : archivedCount > 0
                ? "表示対象の Event はありません (アーカイブ済を含めるには上のチェックボックスを ON)。"
                : "まだ Event はありません。「新規 Event 作成」から始めてください。"}
          </Box>
        }
      />

      <Modal
        visible={archiveTarget !== null}
        header="Event をアーカイブしますか?"
        onDismiss={() => setArchiveTarget(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setArchiveTarget(null)}>キャンセル</Button>
              <Button variant="primary" onClick={handleArchiveConfirm}>
                アーカイブ
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            Event <Box variant="strong">{archiveTarget?.name}</Box> をアーカイブし、 一覧の default
            view から外します。
          </Box>
          <Box variant="small" color="text-status-info">
            ARCHIVED から戻すことはできませんが、配下の deployment / Team 行は TTL で
            自動消去されます。Bulk Teardown が未済の場合は先に実施してください。
          </Box>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

// archive を indirect 化して archive ボタンの onClick からだけ呼べるようにする (= test
// で fakeClient を渡すための seam)。export しない。
async function archive(client: ApiClient, eventId: string): Promise<void> {
  await archiveEvent(client, eventId);
}
