import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type DisruptionCatalogEntry,
  type DisruptionScope,
  type DisruptionTiming,
  type FireDisruptionRequest,
  fireDisruption,
  newFireRequestId,
} from "../../api/disruptions-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** A scope option for the team picker (Multiselect). */
export type TeamOption = { readonly value: string; readonly label: string };

/** The disruption an operator chose to fire (catalog row → modal). */
export interface FireTarget {
  readonly problemId: string;
  readonly item: DisruptionCatalogEntry["disruption"];
}

const SCOPE_OPTIONS: readonly DisruptionScope[] = ["all", "team", "random-n"];
const DEFAULT_AFTER_MINUTES = 30;
const MAX_AFTER_MINUTES = 1440;
// recurring fire の既定/上限。 maxFires は always-ends の回数上限 (= schema と一致)。
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_FIRES = 5;
const MAX_MAX_FIRES = 60;

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
 * success flash back to the panel. Extracted so the panel stays a thin orchestrator + the form is a
 * cohesive unit (adds the immediate/scheduled/recurring timing toggle here).
 */
export function FireModal({
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
