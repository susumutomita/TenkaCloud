import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type DisruptionAuditRow,
  type DisruptionCatalogEntry,
  type DisruptionScope,
  type DisruptionTiming,
  type FireDisruptionRequest,
  fetchDisruptionAudit,
  fetchDisruptionCatalog,
  fireDisruption,
  newFireRequestId,
} from "../../api/disruptions-client";
import type { TeamSummary } from "../../api/events-client";
import { describeTriggers } from "../../lib/disruption-triggers";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

type TeamOption = { readonly value: string; readonly label: string };

const SCOPE_OPTIONS: readonly DisruptionScope[] = ["all", "team", "random-n"];
const AUDIT_LIMIT = 20;
const DEFAULT_AFTER_MINUTES = 30;
const MAX_AFTER_MINUTES = 1440;
// [ADR-037] recurring fire の既定/上限。 maxFires は always-ends の回数上限 (= schema と一致)。
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_FIRES = 5;
const MAX_MAX_FIRES = 60;

interface FireTarget {
  readonly problemId: string;
  readonly item: DisruptionCatalogEntry["disruption"];
}

/** Build the fire request from the modal state (pure — keeps the modal flat). */
function buildFireRequest(
  target: FireTarget,
  scope: DisruptionScope,
  selectedTeamIds: readonly string[],
  timing: DisruptionTiming,
  afterMinutes: number,
  intervalMinutes: number,
  maxFires: number,
): FireDisruptionRequest {
  return {
    problemId: target.problemId,
    disruptionId: target.item.id,
    scope,
    ...(scope === "team" ? { targetTeamIds: selectedTeamIds } : {}),
    ...(scope === "random-n" ? { randomCount: Math.max(selectedTeamIds.length, 1) } : {}),
    ...(target.item.parameters ? { parameters: target.item.parameters } : {}),
    ...(timing === "scheduled" ? { timing: "scheduled" as const, afterMinutes } : {}),
    ...(timing === "recurring" ? { timing: "recurring" as const, intervalMinutes, maxFires } : {}),
    requestId: newFireRequestId(),
  };
}

/** 1〜1440 分の整数でなければ true (= scheduled / recurring interval の共通バリデーション)。 */
function isMinutesInvalid(minutes: number): boolean {
  return !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_AFTER_MINUTES;
}

/** recurring の interval (分) / maxFires のどちらかが範囲外なら true。 */
function isRecurringInvalid(intervalMinutes: number, maxFires: number): boolean {
  return (
    isMinutesInvalid(intervalMinutes) ||
    !Number.isInteger(maxFires) ||
    maxFires < 1 ||
    maxFires > MAX_MAX_FIRES
  );
}

/** Fire 成功時の flash 文言を timing 別に組む (= 三項ネストを避けて branch を pin しやすく)。 */
function firedFlash(
  t: (key: string, params?: Record<string, string | number>) => string,
  timing: DisruptionTiming,
  name: string,
  count: number,
  nums: {
    readonly afterMinutes: number;
    readonly intervalMinutes: number;
    readonly maxFires: number;
  },
): string {
  if (timing === "scheduled") {
    return t("disruptions.scheduled_flash", { name, minutes: nums.afterMinutes });
  }
  if (timing === "recurring") {
    return t("disruptions.recurring_flash", {
      name,
      interval: nums.intervalMinutes,
      count: nums.maxFires,
    });
  }
  return t("disruptions.fired_flash", { name, count });
}

/**
 * Fire modal — owns its own form state (scope / timing / minutes), fires once, and reports the
 * success flash back to the panel. Extracted so the panel stays a thin list + the form is a
 * cohesive unit ([ADR-037] adds the immediate/scheduled timing toggle here).
 */
function FireModal({
  apiClient,
  canMutateTenant,
  eventId,
  target,
  teamOptions,
  t,
  onClose,
  onFired,
}: {
  readonly apiClient: ApiClient;
  readonly canMutateTenant: boolean;
  readonly eventId: string;
  readonly target: FireTarget;
  readonly teamOptions: readonly TeamOption[];
  readonly t: Translate;
  readonly onClose: () => void;
  readonly onFired: (flash: string) => void;
}) {
  const [scope, setScope] = useState<DisruptionScope>("all");
  const [selectedTeamIds, setSelectedTeamIds] = useState<readonly string[]>([]);
  const [timing, setTiming] = useState<DisruptionTiming>("immediate");
  const [afterMinutes, setAfterMinutes] = useState<number>(
    target.item.defaultAfterMinutes ?? DEFAULT_AFTER_MINUTES,
  );
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_INTERVAL_MINUTES);
  const [maxFires, setMaxFires] = useState<number>(DEFAULT_MAX_FIRES);
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);

  const scheduleInvalid = timing === "scheduled" && isMinutesInvalid(afterMinutes);
  const recurringInvalid = timing === "recurring" && isRecurringInvalid(intervalMinutes, maxFires);
  const fireDisabled =
    !canMutateTenant ||
    firing ||
    (scope === "team" && selectedTeamIds.length === 0) ||
    scheduleInvalid ||
    recurringInvalid;

  const confirmFire = async () => {
    /* v8 ignore next -- defensive: the Fire button is disabled={fireDisabled} and fireDisabled already includes !canMutateTenant, so the !canMutateTenant side is unreachable here */
    if (!canMutateTenant || fireDisabled) return;
    setFiring(true);
    setFireError(null);
    try {
      const result = await fireDisruption(
        apiClient,
        eventId,
        buildFireRequest(
          target,
          scope,
          selectedTeamIds,
          timing,
          afterMinutes,
          intervalMinutes,
          maxFires,
        ),
      );
      onFired(
        firedFlash(t, timing, target.item.name, result.affectedTeamIds.length, {
          afterMinutes,
          intervalMinutes,
          maxFires,
        }),
      );
    } catch (err) {
      setFireError(toErrorMessage(err));
    } finally {
      setFiring(false);
    }
  };

  const teamPicker = (label: string, description?: string) => (
    <FormField label={label} description={description}>
      <Multiselect
        selectedOptions={teamOptions.filter((o) => selectedTeamIds.includes(o.value))}
        options={teamOptions}
        onChange={(e) => setSelectedTeamIds(e.detail.selectedOptions.map((o) => o.value as string))}
        placeholder={t("disruptions.teams_placeholder")}
      />
    </FormField>
  );

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={t("disruptions.fire_modal_header", { name: target.item.name })}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onClose} disabled={firing}>
              {t("disruptions.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmFire()}
              loading={firing}
              disabled={fireDisabled}
            >
              {t("disruptions.confirm_fire")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {fireError ? <Alert type="error">{fireError}</Alert> : null}
        <Box color="text-body-secondary">{target.item.description}</Box>
        <FormField
          label={t("disruptions.scope_label")}
          description={t("disruptions.scope_description")}
        >
          <Select
            selectedOption={{ value: scope, label: t(`disruptions.scope_${scope}`) }}
            options={SCOPE_OPTIONS.map((s) => ({ value: s, label: t(`disruptions.scope_${s}`) }))}
            onChange={(e) => setScope(e.detail.selectedOption.value as DisruptionScope)}
          />
        </FormField>
        {scope === "team" ? teamPicker(t("disruptions.teams_label")) : null}
        {scope === "random-n"
          ? teamPicker(t("disruptions.random_label"), t("disruptions.random_description"))
          : null}
        <FormField
          label={t("disruptions.timing_label")}
          description={t("disruptions.timing_description")}
        >
          <SegmentedControl
            selectedId={timing}
            onChange={(e) => setTiming(e.detail.selectedId as DisruptionTiming)}
            options={[
              { id: "immediate", text: t("disruptions.timing_immediate") },
              { id: "scheduled", text: t("disruptions.timing_scheduled") },
              { id: "recurring", text: t("disruptions.timing_recurring") },
            ]}
          />
        </FormField>
        {timing === "scheduled" ? (
          <FormField
            label={t("disruptions.after_minutes_label")}
            description={t("disruptions.after_minutes_description")}
            errorText={scheduleInvalid ? t("disruptions.after_minutes_error") : undefined}
          >
            <Input
              type="number"
              value={String(afterMinutes)}
              onChange={(e) => setAfterMinutes(Number(e.detail.value))}
            />
          </FormField>
        ) : null}
        {timing === "recurring" ? (
          <FormField
            label={t("disruptions.recurring_label")}
            description={t("disruptions.recurring_description")}
            errorText={recurringInvalid ? t("disruptions.recurring_error") : undefined}
          >
            <SpaceBetween size="xs" direction="horizontal">
              <Input
                type="number"
                value={String(intervalMinutes)}
                onChange={(e) => setIntervalMinutes(Number(e.detail.value))}
                ariaLabel={t("disruptions.recurring_interval_label")}
              />
              <Input
                type="number"
                value={String(maxFires)}
                onChange={(e) => setMaxFires(Number(e.detail.value))}
                ariaLabel={t("disruptions.recurring_maxfires_label")}
              />
            </SpaceBetween>
          </FormField>
        ) : null}
      </SpaceBetween>
    </Modal>
  );
}

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
  eventId,
  teams,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly eventId: string;
  readonly teams: readonly TeamSummary[];
  readonly t: Translate;
}) {
  const [catalog, setCatalog] = useState<readonly DisruptionCatalogEntry[] | null>(null);
  const [audit, setAudit] = useState<readonly DisruptionAuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fireTarget, setFireTarget] = useState<FireTarget | null>(null);
  const [lastFired, setLastFired] = useState<string | null>(null);

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
              // [#1775 / ADR-013 Phase 2] metadata 宣言の自動発火条件 (OR 結合) を読み取り表示。
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
              // [ADR-037] scheduled fire の注入予定時刻 (即時 fire は "-")。
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
