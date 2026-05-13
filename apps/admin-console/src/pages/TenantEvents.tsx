import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AdminInsightApiError,
  type EventStatus,
  type EventSummary,
  fetchTenantEvents,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Phase 1.B drill-down (ADR-011 / #598)。
 *
 * System Admin が tenant 一覧から行を click し、その tenant に紐づく Event の一覧に到達
 * するページ。Event 行 click で `AdminEventDetail` に遷移。
 *
 * 設計:
 *   - polling 30s (= read-only / SystemAdmin scope なので high-freq は不要)
 *   - 403 (= claim 不足) は専用 Alert で表示。再ログインで復旧することを案内する
 *   - Tenant Admin の EventList は write 操作 (archive 等) を持つが、本 page は **read-only**
 */
const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 50;

/**
 * Issue #656: tenant API が provisioning 中 (= CodePipeline 進行中で API Gateway 未存在)
 * のとき fetch が `TypeError: Failed to fetch` を起こす or backend が 502/503/504 を返す。
 * このいずれかなら "プロビジョニング中" UI を出し、 raw error を隠す。
 */
function isLikelyProvisioning(err: unknown): boolean {
  if (err instanceof AdminInsightApiError) {
    return (
      err.status === StatusCodes.BAD_GATEWAY ||
      err.status === StatusCodes.SERVICE_UNAVAILABLE ||
      err.status === StatusCodes.GATEWAY_TIMEOUT
    );
  }
  if (err instanceof TypeError) return true;
  if (err instanceof Error && /failed to fetch/i.test(err.message)) return true;
  return false;
}

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

export function TenantEventsPage({ config }: { config: AppConfig }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const auth = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

  const idToken = auth.tokens?.idToken;

  const fetchOnce = useCallback(async () => {
    if (!idToken || !tenantId) return;
    try {
      const res = await fetchTenantEvents(config, idToken, tenantId, { limit: PAGE_SIZE });
      if (res === null) {
        setNotConfigured(true);
        return;
      }
      setItems(res.items);
      setError(null);
      setForbidden(false);
      setProvisioning(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN) {
        setForbidden(true);
      } else if (isLikelyProvisioning(err)) {
        setProvisioning(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [config, idToken, tenantId]);

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

  if (!tenantId) {
    return <Alert type="error">tenantId が指定されていません。</Alert>;
  }

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

  if (provisioning) {
    return (
      <SpaceBetween size="l">
        <Header
          variant="h1"
          description={`Tenant ID: ${tenantId}`}
          actions={
            <Button variant="normal" onClick={() => navigate("/tenants")}>
              テナント一覧に戻る
            </Button>
          }
        >
          テナント Event 一覧
        </Header>
        <Alert type="info" header="テナントを準備中です">
          この tenant の API はまだ deploy 中のため Event 一覧を取得できません。 provisioning は通常
          5〜10 分で完了します。 30 秒ごとに自動で再試行します。
        </Alert>
        <Box textAlign="center" padding="l">
          <Spinner /> 接続待機中…
        </Box>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Tenant ID: ${tenantId}`}
        actions={
          <Button variant="normal" onClick={() => navigate("/tenants")}>
            テナント一覧に戻る
          </Button>
        }
      >
        テナント Event 一覧
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
        <Table<EventSummary>
          variant="container"
          items={[...(items ?? [])]}
          trackBy="eventId"
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              この tenant にはまだ Event がありません。
            </Box>
          }
          columnDefinitions={[
            {
              id: "name",
              header: "Event 名",
              cell: (item) => (
                <Link
                  fontSize="body-m"
                  href={`/tenants/${encodeURIComponent(tenantId)}/events/${encodeURIComponent(item.eventId)}`}
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate(
                      `/tenants/${encodeURIComponent(tenantId)}/events/${encodeURIComponent(item.eventId)}`,
                    );
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
            { id: "updatedAt", header: "更新", cell: (item) => item.updatedAt },
          ]}
        />
      )}
    </SpaceBetween>
  );
}
