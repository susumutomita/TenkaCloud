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
import { interpolate, useT } from "../i18n";
import { toErrorMessage } from "../lib/error-message";

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

// Lambda invocation コスト抑制のため 30 秒 (= 過去 10 秒 polling は 6 req/min/user で
// EventApi 発火が過多)。 list 系は 30 秒粒度で十分。
const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 50;

interface ColumnContext {
  navigate: NavigateFunction;
  onArchiveClick: (item: EventSummary) => void;
  archivingId: string | null;
  t: (key: string) => string;
}

function buildColumns(ctx: ColumnContext): TableProps.ColumnDefinition<EventSummary>[] {
  return [
    {
      id: "name",
      header: ctx.t("event_list.col_name"),
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
      header: ctx.t("event_list.col_status"),
      cell: (item) => (
        <Badge color={STATUS_COLOR[item.status]}>
          {ctx.t(`event_list.status_label.${item.status}`)}
        </Badge>
      ),
    },
    {
      id: "teamCount",
      header: ctx.t("event_list.col_team_count"),
      cell: (item) => item.teamCount,
    },
    {
      id: "problemCount",
      header: ctx.t("event_list.col_problem_count"),
      cell: (item) => item.problemCount,
    },
    { id: "createdAt", header: ctx.t("event_list.col_created_at"), cell: (item) => item.createdAt },
    {
      id: "actions",
      header: ctx.t("event_list.col_actions"),
      cell: (item) => (
        <Button
          variant="link"
          loading={ctx.archivingId === item.eventId}
          disabled={!ARCHIVABLE_STATUSES.has(item.status)}
          onClick={() => ctx.onArchiveClick(item)}
          ariaLabel={interpolate(ctx.t("event_list.archive_aria"), { name: item.name })}
        >
          {ctx.t("event_list.archive_action")}
        </Button>
      ),
    },
  ];
}

type TFn = (key: string) => string;

/**
 * Archive 失敗時の error を user 向け文字列に整形する。 409 は CFn の `currentStatus` から
 * 「DRAFT で archive できない」 「READY のままで archive できない」 等の文脈付き message を
 * 出す。 それ以外は generic な Error message を流す。
 */
export function describeArchiveError(err: unknown, name: string, t: TFn): string {
  if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
    const match = err.message.match(/"currentStatus"\s*:\s*"([A-Z_]+)"/);
    const current = match?.[1];
    return current
      ? interpolate(t("event_list.archive_conflict_known"), { name, current })
      : interpolate(t("event_list.archive_conflict_unknown"), { name });
  }
  return toErrorMessage(err);
}

export function EventListPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const t = useT();
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
      setError(toErrorMessage(err));
    }
  }, [apiClient]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // unmount 時に clearInterval するので interval 経由の再 tick は来ない。 cancelled=true を
      // 踏むのは teardown と既 queue の tick が競合する稀ケースのみ (= 防御的、不到達)。
      /* v8 ignore next */
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
    // confirm button は modal が開いた (= archiveTarget が set された) ときだけ押せ、 apiClient は
    // items 取得成功後にしか main render へ到達しないので、 この guard は両条件とも UI 経路では
    // 不到達の防御 (= 型 narrowing も兼ねる)。
    /* v8 ignore next */
    if (!apiClient || !archiveTarget) return;
    const target = archiveTarget;
    setArchivingId(target.eventId);
    setArchiveTarget(null);
    setError(null);
    try {
      await archive(apiClient, target.eventId);
      await fetchOnce();
    } catch (err) {
      setError(describeArchiveError(err, target.name, t));
    } finally {
      setArchivingId(null);
    }
  };

  const columns = useMemo(
    () => buildColumns({ navigate, onArchiveClick, archivingId, t }),
    [navigate, onArchiveClick, archivingId, t],
  );

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("event_list.loading")}
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("event_list.description")}
        actions={
          <Button variant="primary" onClick={() => navigate("/events/new")}>
            {t("event_list.create_button")}
          </Button>
        }
      >
        {t("event_list.header")}
      </Header>

      {error && (
        <Alert
          type="error"
          header={t("event_list.error_header")}
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {archivedCount > 0 && (
        <Checkbox checked={showArchived} onChange={({ detail }) => setShowArchived(detail.checked)}>
          {interpolate(t("event_list.show_archived"), { count: String(archivedCount) })}
        </Checkbox>
      )}

      <Table
        items={visible}
        columnDefinitions={columns}
        loadingText={t("event_list.loading")}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {showArchived || archivedCount === 0
              ? t("event_list.empty_no_event")
              : t("event_list.empty_all_archived")}
          </Box>
        }
      />

      <Modal
        visible={archiveTarget !== null}
        header={t("event_list.archive_modal_header")}
        onDismiss={() => setArchiveTarget(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setArchiveTarget(null)}>
                {t("event_list.archive_modal_cancel")}
              </Button>
              <Button variant="primary" onClick={handleArchiveConfirm}>
                {t("event_list.archive_modal_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            {interpolate(t("event_list.archive_modal_body"), {
              name: archiveTarget?.name ?? "",
            })}
          </Box>
          <Box variant="small" color="text-status-info">
            {t("event_list.archive_modal_note")}
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
