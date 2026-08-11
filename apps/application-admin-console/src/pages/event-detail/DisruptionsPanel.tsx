import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type DisruptionAuditRow,
  type DisruptionCatalogEntry,
  fetchDisruptionAudit,
  fetchDisruptionCatalog,
} from "../../api/disruptions-client";
import type { EventDetail } from "../../api/events-client";
import { describeTriggers } from "../../lib/disruption-triggers";
import { FireModal, type FireTarget, type TeamOption } from "./FireModal";
import { RecurringPanel } from "./RecurringPanel";
import { TeamStatusPanel } from "./TeamStatusPanel";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const AUDIT_LIMIT = 20;

/**
 * [#1417 / #1666] Operator red-team console. Lists the event's declared disruptions (catalog) and
 * lets the operator fire one at a scope (all / team / random-n); shows the fire audit log. Generic
 * — driven entirely by the catalog, so any Battle's declared disruptions appear here. Fires with
 * the disruption's declared default parameters (per-parameter editing is a follow-up). Feature-
 * flagged (`redTeam`) because the cross-account executor is not yet verified live on AWS.
 */
export function DisruptionsPanel({
  apiClient,
  canMutateTenant,
  detail,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly t: Translate;
}) {
  // eventId / teams は EventDetail から取り出す (= status view と同じ source を共有)。
  const { eventId, teams } = detail;
  const [catalog, setCatalog] = useState<readonly DisruptionCatalogEntry[] | null>(null);
  const [audit, setAudit] = useState<readonly DisruptionAuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fireTarget, setFireTarget] = useState<FireTarget | null>(null);
  const [lastFired, setLastFired] = useState<string | null>(null);
  // bump 後に RecurringPanel が一覧を取り直す (= 定期 fire 直後に反映する) signal。
  const [recurringRefresh, setRecurringRefresh] = useState(0);

  const reloadAudit = useCallback(async () => {
    // Only called after a successful fire (apiClient was present) — defensive, unreachable.
    /* v8 ignore next */
    if (!apiClient) return;
    const res = await fetchDisruptionAudit(apiClient, eventId, { limit: AUDIT_LIMIT });
    setAudit(res.items);
  }, [apiClient, eventId]);

  useEffect(() => {
    if (!apiClient) return;
    setLoadError(null);
    Promise.all([
      fetchDisruptionCatalog(apiClient, eventId),
      fetchDisruptionAudit(apiClient, eventId, { limit: AUDIT_LIMIT }),
    ])
      .then(([cat, aud]) => {
        setCatalog(cat.entries);
        setAudit(aud.items);
      })
      .catch((err) => setLoadError(toErrorMessage(err)));
  }, [apiClient, eventId]);

  const teamOptions = useMemo<readonly TeamOption[]>(
    () => teams.map((tm) => ({ value: tm.teamId, label: tm.displayName || tm.internalSlug })),
    [teams],
  );

  const onFired = (flash: string) => {
    setLastFired(flash);
    setFireTarget(null);
    void reloadAudit();
    // recurring fire なら 「実行中の定期障害」 一覧に新規行が出るよう取り直しを促す。
    setRecurringRefresh((n) => n + 1);
  };

  return (
    <Container
      header={
        <Header variant="h2" description={t("disruptions.description")}>
          {t("disruptions.header")}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {loadError ? <Alert type="error">{loadError}</Alert> : null}
        {lastFired ? (
          <Alert type="success" dismissible onDismiss={() => setLastFired(null)}>
            {lastFired}
          </Alert>
        ) : null}

        {/* [#1916] 「いつ撃つか」 を判断するための per-team status を catalog の前に置く。
         *  撃ち込み履歴は同じ audit を再利用 (= 二重 fetch しない)。 */}
        <TeamStatusPanel detail={detail} audit={audit} t={t} />

        <Table
          variant="embedded"
          // 障害 description は作者が書く長文 (= 1 段落) なので wrapLines で折り返し、 各列に幅を与えて
          // 横溢れ (= 説明が見切れて「発火」ボタンが潰れる) を防ぐ (#1710 follow-up: UI 可読性)。
          wrapLines
          columnDefinitions={[
            {
              id: "name",
              header: t("disruptions.col_name"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.name,
              width: 220,
            },
            {
              id: "problem",
              header: t("disruptions.col_problem"),
              cell: (e: DisruptionCatalogEntry) => e.problemId,
              width: 220,
            },
            {
              id: "description",
              header: t("disruptions.col_description"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.description,
              maxWidth: 560,
            },
            {
              // Issue #1775: metadata 宣言の自動発火条件 (OR 結合) を読み取り表示。
              // 条件の source of truth は problem の metadata.json なのでここでは編集しない。
              id: "autoFire",
              header: t("disruptions.col_auto_fire"),
              cell: (e: DisruptionCatalogEntry) => {
                const labels = describeTriggers(e.disruption.triggers, t);
                if (labels.length === 0) {
                  return (
                    <Box variant="small" color="text-status-inactive">
                      {t("disruptions.trigger_manual_only")}
                    </Box>
                  );
                }
                return (
                  <SpaceBetween size="xxs">
                    {labels.map((label) => (
                      <Box key={label} variant="small">
                        {label}
                      </Box>
                    ))}
                  </SpaceBetween>
                );
              },
              width: 220,
            },
            {
              id: "fire",
              header: "",
              width: 110,
              cell: (e: DisruptionCatalogEntry) => (
                <Button
                  variant="inline-link"
                  disabled={!canMutateTenant}
                  onClick={() => setFireTarget({ problemId: e.problemId, item: e.disruption })}
                >
                  {t("disruptions.fire_button")}
                </Button>
              ),
            },
          ]}
          items={catalog ?? []}
          loading={catalog === null && !loadError}
          loadingText={t("disruptions.loading")}
          empty={<Box textAlign="center">{t("disruptions.catalog_empty")}</Box>}
        />

        <RecurringPanel
          key={recurringRefresh}
          apiClient={apiClient}
          canMutateTenant={canMutateTenant}
          eventId={eventId}
          t={t}
        />

        <Header variant="h3">{t("disruptions.audit_header")}</Header>
        <Table
          variant="embedded"
          columnDefinitions={[
            {
              id: "firedAt",
              header: t("disruptions.col_fired_at"),
              cell: (r: DisruptionAuditRow) => r.firedAt,
            },
            {
              id: "disruptionId",
              header: t("disruptions.col_name"),
              cell: (r: DisruptionAuditRow) => r.disruptionId,
            },
            {
              id: "scope",
              header: t("disruptions.col_scope"),
              cell: (r: DisruptionAuditRow) => r.scope,
            },
            {
              id: "affected",
              header: t("disruptions.col_affected"),
              cell: (r: DisruptionAuditRow) => String(r.targetTeamIds.length),
            },
            {
              // scheduled fire の注入予定時刻 (即時 fire は "-")。
              id: "scheduledFor",
              header: t("disruptions.col_scheduled_for"),
              cell: (r: DisruptionAuditRow) => r.scheduledFor ?? "-",
            },
          ]}
          items={audit}
          empty={<Box textAlign="center">{t("disruptions.audit_empty")}</Box>}
        />
      </SpaceBetween>

      {fireTarget && apiClient ? (
        <FireModal
          key={`${fireTarget.problemId}:${fireTarget.item.id}`}
          apiClient={apiClient}
          canMutateTenant={canMutateTenant}
          eventId={eventId}
          target={fireTarget}
          teamOptions={teamOptions}
          t={t}
          onClose={() => setFireTarget(null)}
          onFired={onFired}
        />
      ) : null}
    </Container>
  );
}
