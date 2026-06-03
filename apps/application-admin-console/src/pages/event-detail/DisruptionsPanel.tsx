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

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

type TeamOption = { readonly value: string; readonly label: string };

const SCOPE_OPTIONS: readonly DisruptionScope[] = ["all", "team", "random-n"];
const AUDIT_LIMIT = 20;
const DEFAULT_AFTER_MINUTES = 30;
const MAX_AFTER_MINUTES = 1440;

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
): FireDisruptionRequest {
  return {
    problemId: target.problemId,
    disruptionId: target.item.id,
    scope,
    ...(scope === "team" ? { targetTeamIds: selectedTeamIds } : {}),
    ...(scope === "random-n" ? { randomCount: Math.max(selectedTeamIds.length, 1) } : {}),
    ...(target.item.parameters ? { parameters: target.item.parameters } : {}),
    ...(timing === "scheduled" ? { timing: "scheduled" as const, afterMinutes } : {}),
    requestId: newFireRequestId(),
  };
}

/**
 * Fire modal — owns its own form state (scope / timing / minutes), fires once, and reports the
 * success flash back to the panel. Extracted so the panel stays a thin list + the form is a
 * cohesive unit ([ADR-037] adds the immediate/scheduled timing toggle here).
 */
function FireModal({
  apiClient,
  eventId,
  target,
  teamOptions,
  t,
  onClose,
  onFired,
}: {
  readonly apiClient: ApiClient;
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
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);

  const scheduleInvalid =
    timing === "scheduled" &&
    (!Number.isInteger(afterMinutes) || afterMinutes < 1 || afterMinutes > MAX_AFTER_MINUTES);
  const fireDisabled =
    firing || (scope === "team" && selectedTeamIds.length === 0) || scheduleInvalid;

  const confirmFire = async () => {
    setFiring(true);
    setFireError(null);
    try {
      const result = await fireDisruption(
        apiClient,
        eventId,
        buildFireRequest(target, scope, selectedTeamIds, timing, afterMinutes),
      );
      onFired(
        timing === "scheduled"
          ? t("disruptions.scheduled_flash", { name: target.item.name, minutes: afterMinutes })
          : t("disruptions.fired_flash", {
              name: target.item.name,
              count: result.affectedTeamIds.length,
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
  eventId,
  teams,
  t,
}: {
  readonly apiClient: ApiClient | null;
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
          columnDefinitions={[
            {
              id: "name",
              header: t("disruptions.col_name"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.name,
            },
            {
              id: "problem",
              header: t("disruptions.col_problem"),
              cell: (e: DisruptionCatalogEntry) => e.problemId,
            },
            {
              id: "description",
              header: t("disruptions.col_description"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.description,
            },
            {
              id: "fire",
              header: "",
              cell: (e: DisruptionCatalogEntry) => (
                <Button
                  variant="inline-link"
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
