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
import { useT } from "../i18n";

/**
 * Phase 1.B drill-down (ADR-011 / #598)。 i18n: #655 Phase 5.C で 4 言語化済。
 */
const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 50;

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
  const t = useT();
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
    return <Alert type="error">{t("tenant_events.missing_tenant_id")}</Alert>;
  }

  if (notConfigured) {
    return (
      <Alert type="info" header={t("tenant_events.not_configured_header")}>
        {t("tenant_events.not_configured_body")}
      </Alert>
    );
  }

  if (forbidden) {
    return (
      <Alert type="error" header={t("tenant_events.forbidden_header")}>
        {t("tenant_events.forbidden_body")}
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
              {t("tenant_events.back_button")}
            </Button>
          }
        >
          {t("tenant_events.header")}
        </Header>
        <Alert type="info" header={t("tenant_events.provisioning_header")}>
          {t("tenant_events.provisioning_body")}
        </Alert>
        <Box textAlign="center" padding="l">
          <Spinner /> {t("tenant_events.provisioning_spinner")}
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
            {t("tenant_events.back_button")}
          </Button>
        }
      >
        {t("tenant_events.header")}
      </Header>

      {error && (
        <Alert
          type="error"
          header={t("tenant_events.error_header")}
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {items === null && !error ? (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("tenant_events.loading")}
        </Box>
      ) : (
        <Table<EventSummary>
          variant="container"
          items={[...(items ?? [])]}
          trackBy="eventId"
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              {t("tenant_events.empty")}
            </Box>
          }
          columnDefinitions={[
            {
              id: "name",
              header: t("tenant_events.col_name"),
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
              header: t("tenant_events.col_status"),
              cell: (item) => <Badge color={STATUS_COLOR[item.status]}>{item.status}</Badge>,
            },
            {
              id: "teamCount",
              header: t("tenant_events.col_team_count"),
              cell: (item) => item.teamCount,
            },
            {
              id: "problemCount",
              header: t("tenant_events.col_problem_count"),
              cell: (item) => item.problemCount,
            },
            {
              id: "createdAt",
              header: t("tenant_events.col_created_at"),
              cell: (item) => item.createdAt,
            },
            {
              id: "updatedAt",
              header: t("tenant_events.col_updated_at"),
              cell: (item) => item.updatedAt,
            },
          ]}
        />
      )}
    </SpaceBetween>
  );
}
