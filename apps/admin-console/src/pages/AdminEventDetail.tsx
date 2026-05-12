import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AdminInsightApiError,
  type DeploymentStatus,
  type EventDeploymentSummary,
  type EventDetail,
  type EventStatus,
  fetchTenantEventDetail,
  type TeamSummary,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Phase 1.B drill-down — Event 詳細 (read-only mirror、ADR-011 / #598)。
 *
 * Application Admin Console の EventDetail.tsx と異なる点:
 *   - read-only。Bulk Deploy / Archive / Schedule の **operator 操作 button は持たない**
 *   - `teamLoginKey` は **`••••` で blackout**。backend が undefined を返す前提だが、
 *     仮に何らかで残ってもここで再度マスクする (= 二重防御)
 *
 * polling 30s。Event detail は team / deploy job 状況が動くので、それなりに頻度を上げる。
 */
const POLL_INTERVAL_MS = 30_000;
const EVENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

const DEPLOY_STATUS_COLOR: Record<DeploymentStatus, "blue" | "green" | "grey" | "red"> = {
  PENDING: "grey",
  IN_PROGRESS: "blue",
  COMPLETE: "green",
  FAILED: "red",
  DELETING: "grey",
  DELETED: "grey",
};

/**
 * teamLoginKey は **black-out**。backend は undefined を返すが、UI 側でも常に `••••` 表示で
 * 「ここには見えないし、見せない」 という意図を明示する (= ADR-011 D2)。
 */
function renderTeamLoginKeyBlackout() {
  return (
    <Box variant="small" color="text-status-inactive">
      ••••
    </Box>
  );
}

function renderProblemDeployStatus(deployments: readonly EventDeploymentSummary[] | undefined) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        未デプロイ
      </Box>
    );
  }
  const total = deployments.length;
  const complete = deployments.filter((d) => d.status === "COMPLETE").length;
  const failed = deployments.filter((d) => d.status === "FAILED").length;
  const inFlight = deployments.filter(
    (d) => d.status === "PENDING" || d.status === "IN_PROGRESS",
  ).length;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Box variant="strong">
        {complete} / {total}
      </Box>
      {failed > 0 && <Badge color="red">FAILED {failed}</Badge>}
      {inFlight > 0 && <Badge color="blue">進行中 {inFlight}</Badge>}
    </SpaceBetween>
  );
}

export function AdminEventDetailPage({ config }: { config: AppConfig }) {
  const { tenantId, eventId } = useParams<{ tenantId: string; eventId: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const idToken = auth.tokens?.idToken;

  const fetchOnce = useCallback(async () => {
    if (!idToken || !tenantId || !eventId) return;
    try {
      const res = await fetchTenantEventDetail(config, idToken, tenantId, eventId);
      if (res === null) return; // adminInsightApiUrl 未配線
      setDetail(res);
      setError(null);
      setForbidden(false);
      setNotFound(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError) {
        if (err.status === StatusCodes.FORBIDDEN) {
          setForbidden(true);
          return;
        }
        if (err.status === StatusCodes.NOT_FOUND) {
          setNotFound(true);
          return;
        }
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config, idToken, tenantId, eventId]);

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

  if (!tenantId || !eventId || !EVENT_ID_RE.test(eventId)) {
    return <Alert type="error">不正なパラメータです。</Alert>;
  }

  if (forbidden) {
    return (
      <Alert type="error" header="権限がありません">
        この機能は SystemAdmin group のメンバーのみ閲覧できます。ログインし直してください。
      </Alert>
    );
  }

  if (notFound) {
    return (
      <SpaceBetween size="l">
        <Header
          variant="h1"
          actions={
            <Button
              variant="normal"
              onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
            >
              Event 一覧に戻る
            </Button>
          }
        >
          Event が見つかりません
        </Header>
        <Alert type="warning">
          Tenant {tenantId} に event {eventId} は存在しません。
        </Alert>
      </SpaceBetween>
    );
  }

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 状態を取得中…
      </Box>
    );
  }

  if (error && !detail) {
    return (
      <Alert type="error" header="Event 詳細の取得に失敗しました">
        {error}
      </Alert>
    );
  }

  if (!detail) return null;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={
          <>
            Tenant: <code>{tenantId}</code> / Event ID: <code>{detail.eventId}</code>
          </>
        }
        actions={
          <Button
            variant="normal"
            onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
          >
            Event 一覧に戻る
          </Button>
        }
      >
        {detail.name}
      </Header>

      {error && (
        <Alert
          type="warning"
          header="再読み込みに失敗しました"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Container header={<Header variant="h2">サマリー</Header>}>
        <KeyValuePairs
          columns={3}
          items={[
            {
              label: "ステータス",
              value: <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>,
            },
            { label: "チーム数", value: detail.teamCount },
            { label: "問題数", value: detail.problemCount },
            { label: "作成", value: detail.createdAt },
            { label: "更新", value: detail.updatedAt },
            { label: "開始時刻", value: detail.startsAt ?? "(未設定)" },
            { label: "終了時刻", value: detail.endsAt ?? "(未設定)" },
            {
              label: "採点 lock",
              value: detail.scoringLocked ? (
                <Badge color="red">LOCKED</Badge>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  unlocked
                </Box>
              ),
            },
          ]}
        />
      </Container>

      <Container header={<Header variant="h2">問題セット ({detail.problems.length})</Header>}>
        <Table
          variant="embedded"
          items={[...detail.problems]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              問題セットは登録されていません。
            </Box>
          }
          columnDefinitions={[
            { id: "problemId", header: "Problem ID", cell: (p) => <code>{p.problemId}</code> },
            { id: "region", header: "Default Region", cell: (p) => p.defaultRegion },
            {
              id: "deployStatus",
              header: "Deploy 状況",
              cell: (p) => renderProblemDeployStatus(detail.deploymentsByProblem[p.problemId]),
            },
            {
              id: "jobs",
              header: "Deploy Job",
              cell: (p) => {
                const list = detail.deploymentsByProblem[p.problemId];
                if (!list || list.length === 0) {
                  return (
                    <Box variant="small" color="text-status-inactive">
                      —
                    </Box>
                  );
                }
                return (
                  <SpaceBetween direction="vertical" size="xxs">
                    {list.map((d) => (
                      <SpaceBetween
                        key={d.jobId}
                        direction="horizontal"
                        size="xxs"
                        alignItems="center"
                      >
                        <Link
                          href={`/tenants/${encodeURIComponent(tenantId)}/deployments/${encodeURIComponent(d.jobId)}`}
                          onFollow={(e) => {
                            e.preventDefault();
                            navigate(
                              `/tenants/${encodeURIComponent(tenantId)}/deployments/${encodeURIComponent(d.jobId)}`,
                            );
                          }}
                        >
                          <Box variant="small">
                            <code>{d.jobId.slice(0, 8)}…</code>
                          </Box>
                        </Link>
                        <Badge color={DEPLOY_STATUS_COLOR[d.status]}>{d.status}</Badge>
                      </SpaceBetween>
                    ))}
                  </SpaceBetween>
                );
              },
            },
          ]}
        />
      </Container>

      <Container header={<Header variant="h2">チーム ({detail.teams.length})</Header>}>
        <Table<TeamSummary>
          variant="embedded"
          items={[...detail.teams]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              チームは登録されていません。
            </Box>
          }
          columnDefinitions={[
            { id: "teamId", header: "Team ID", cell: (t) => <code>{t.teamId}</code> },
            { id: "internalSlug", header: "Slug", cell: (t) => <code>{t.internalSlug}</code> },
            {
              id: "displayName",
              header: "表示名 (競技者選択)",
              cell: (t) => t.displayName ?? "(未設定)",
            },
            {
              id: "awsAccountId",
              header: "AWS Account",
              cell: (t) => (t.awsAccountId ? <code>{t.awsAccountId}</code> : "(未設定)"),
            },
            {
              id: "teamLoginKey",
              header: "ログインキー",
              cell: () => renderTeamLoginKeyBlackout(),
            },
          ]}
        />
        <Box variant="small" color="text-status-info" padding={{ top: "s" }}>
          ※ ログインキーは SystemAdmin 経路では露出しません (ADR-011 D2)。Tenant Admin の Event
          詳細ページで参照してください。
        </Box>
      </Container>
    </SpaceBetween>
  );
}
