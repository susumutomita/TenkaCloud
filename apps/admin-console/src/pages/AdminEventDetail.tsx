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
import { interpolate, useT } from "../i18n";

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

function renderProblemDeployStatus(
  deployments: readonly EventDeploymentSummary[] | undefined,
  t: (key: string) => string,
) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        {t("admin_event_detail.deploy_not_started")}
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
      {failed > 0 && (
        <Badge color="red">
          {interpolate(t("admin_event_detail.deploy_failed_count"), { count: String(failed) })}
        </Badge>
      )}
      {inFlight > 0 && (
        <Badge color="blue">
          {interpolate(t("admin_event_detail.deploy_in_progress_count"), {
            count: String(inFlight),
          })}
        </Badge>
      )}
    </SpaceBetween>
  );
}

export function AdminEventDetailPage({ config }: { config: AppConfig }) {
  const { tenantId, eventId } = useParams<{ tenantId: string; eventId: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const t = useT();
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
    return <Alert type="error">{t("admin_event_detail.invalid_params")}</Alert>;
  }

  if (forbidden) {
    return (
      <Alert type="error" header={t("admin_event_detail.forbidden_header")}>
        {t("admin_event_detail.forbidden_body")}
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
              {t("admin_event_detail.back_to_events")}
            </Button>
          }
        >
          {t("admin_event_detail.not_found_header")}
        </Header>
        <Alert type="warning">
          {interpolate(t("admin_event_detail.not_found_body"), { tenantId, eventId })}
        </Alert>
      </SpaceBetween>
    );
  }

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("admin_event_detail.loading")}
      </Box>
    );
  }

  if (error && !detail) {
    return (
      <Alert type="error" header={t("admin_event_detail.fetch_error_header")}>
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
            {t("admin_event_detail.tenant_label")}: <code>{tenantId}</code> /{" "}
            {t("admin_event_detail.event_id_label")}: <code>{detail.eventId}</code>
          </>
        }
        actions={
          <Button
            variant="normal"
            onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
          >
            {t("admin_event_detail.back_to_events")}
          </Button>
        }
      >
        {detail.name}
      </Header>

      {error && (
        <Alert
          type="warning"
          header={t("admin_event_detail.reload_error_header")}
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Container header={<Header variant="h2">{t("admin_event_detail.summary_header")}</Header>}>
        <KeyValuePairs
          columns={3}
          items={[
            {
              label: t("admin_event_detail.summary_label_status"),
              value: <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>,
            },
            { label: t("admin_event_detail.summary_label_team_count"), value: detail.teamCount },
            {
              label: t("admin_event_detail.summary_label_problem_count"),
              value: detail.problemCount,
            },
            { label: t("admin_event_detail.summary_label_created"), value: detail.createdAt },
            { label: t("admin_event_detail.summary_label_updated"), value: detail.updatedAt },
            {
              label: t("admin_event_detail.summary_label_starts_at"),
              value: detail.startsAt ?? t("admin_event_detail.unset"),
            },
            {
              label: t("admin_event_detail.summary_label_ends_at"),
              value: detail.endsAt ?? t("admin_event_detail.unset"),
            },
            {
              label: t("admin_event_detail.summary_label_scoring_lock"),
              value: detail.scoringLocked ? (
                <Badge color="red">{t("admin_event_detail.scoring_locked")}</Badge>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  {t("admin_event_detail.scoring_unlocked")}
                </Box>
              ),
            },
          ]}
        />
      </Container>

      <Container
        header={
          <Header variant="h2">
            {interpolate(t("admin_event_detail.problems_header"), {
              count: String(detail.problems.length),
            })}
          </Header>
        }
      >
        <Table
          variant="embedded"
          items={[...detail.problems]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              {t("admin_event_detail.problems_empty")}
            </Box>
          }
          columnDefinitions={[
            {
              id: "problemId",
              header: t("admin_event_detail.col_problem_id"),
              cell: (p) => <code>{p.problemId}</code>,
            },
            {
              id: "region",
              header: t("admin_event_detail.col_default_region"),
              cell: (p) => p.defaultRegion,
            },
            {
              id: "deployStatus",
              header: t("admin_event_detail.col_deploy_status"),
              cell: (p) => renderProblemDeployStatus(detail.deploymentsByProblem[p.problemId], t),
            },
            {
              id: "jobs",
              header: t("admin_event_detail.col_deploy_job"),
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

      <Container
        header={
          <Header variant="h2">
            {interpolate(t("admin_event_detail.teams_header"), {
              count: String(detail.teams.length),
            })}
          </Header>
        }
      >
        <Table<TeamSummary>
          variant="embedded"
          items={[...detail.teams]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              {t("admin_event_detail.teams_empty")}
            </Box>
          }
          columnDefinitions={[
            {
              id: "teamId",
              header: t("admin_event_detail.col_team_id"),
              cell: (t) => <code>{t.teamId}</code>,
            },
            {
              id: "internalSlug",
              header: t("admin_event_detail.col_slug"),
              cell: (t) => <code>{t.internalSlug}</code>,
            },
            {
              id: "displayName",
              header: t("admin_event_detail.col_display_name"),
              cell: (team) => team.displayName ?? t("admin_event_detail.unset"),
            },
            {
              id: "awsAccountId",
              header: t("admin_event_detail.col_aws_account"),
              cell: (team) =>
                team.awsAccountId ? (
                  <code>{team.awsAccountId}</code>
                ) : (
                  t("admin_event_detail.unset")
                ),
            },
            {
              id: "teamLoginKey",
              header: t("admin_event_detail.col_login_key"),
              cell: () => renderTeamLoginKeyBlackout(),
            },
          ]}
        />
        <Box variant="small" color="text-status-info" padding={{ top: "s" }}>
          {t("admin_event_detail.login_key_note")}
        </Box>
      </Container>
    </SpaceBetween>
  );
}
