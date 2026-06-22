import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ApiClient } from "../../api/client";
import type { EventDetail } from "../../api/events-client";
import type { WizardState } from "../../lib/event-wizard";
import { Field, scoringBadge } from "./shared";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventSchedulePanel({
  apiClient,
  canMutateTenant,
  detail,
  endsAtInFlight,
  freezeMinutesInFlight,
  freezeMinutesInput,
  onEndNowSchedule,
  onOpenEndsAtModal,
  onOpenScheduleModal,
  onOpenTeardownModal,
  onSaveFreezeMinutes,
  onStartNow,
  onUpdateFreezeMinutes,
  scheduleInFlight,
  teardownInFlight,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly endsAtInFlight: boolean;
  readonly freezeMinutesInFlight: boolean;
  readonly freezeMinutesInput: string;
  readonly onEndNowSchedule: () => void;
  readonly onOpenEndsAtModal: () => void;
  readonly onOpenScheduleModal: () => void;
  readonly onOpenTeardownModal: () => void;
  readonly onSaveFreezeMinutes: () => void;
  readonly onStartNow: () => void;
  readonly onUpdateFreezeMinutes: (value: string) => void;
  readonly scheduleInFlight: "now" | "scheduled" | null;
  readonly teardownInFlight: boolean;
  readonly t: Translate;
  readonly wizard: WizardState | null;
}) {
  return (
    <Container
      header={
        <Header variant="h2" description={t("event_detail.schedule_description")}>
          {t("event_detail.schedule_header")}
        </Header>
      }
    >
      <ColumnLayout columns={2} variant="text-grid">
        <Field label={t("event_detail.starts_at_label")}>
          <SpaceBetween size="xs">
            {detail.startsAt ? (
              <code>{detail.startsAt}</code>
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("event_detail.starts_at_unset")}
              </Box>
            )}
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={onOpenScheduleModal}
                disabled={!apiClient || !canMutateTenant || scheduleInFlight !== null}
              >
                {t("event_detail.starts_at_pick")}
              </Button>
              <Button
                variant={wizard?.primary === "start" ? "primary" : "normal"}
                loading={scheduleInFlight === "now"}
                disabled={!apiClient || !canMutateTenant || scheduleInFlight === "scheduled"}
                onClick={onStartNow}
              >
                {t("event_detail.starts_at_now")}
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Field>
        <Field label={t("event_detail.ends_at_label")}>
          <SpaceBetween size="xs">
            {detail.endsAt ? (
              <code>{detail.endsAt}</code>
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("event_detail.ends_at_unset")}
              </Box>
            )}
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={onOpenEndsAtModal}
                disabled={!apiClient || !canMutateTenant || endsAtInFlight}
              >
                {t("event_detail.ends_at_pick")}
              </Button>
              <Button
                loading={endsAtInFlight}
                disabled={!apiClient || !canMutateTenant}
                onClick={onEndNowSchedule}
              >
                {t("event_detail.ends_at_now")}
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Field>
      </ColumnLayout>
      <Box margin={{ top: "m" }}>
        <Field label={t("event_detail.scoring_status_label")}>{scoringBadge(detail, t)}</Field>
      </Box>
      <Box margin={{ top: "m" }}>
        <Field label={t("event_detail.freeze_label")}>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Box variant="small" color="text-status-inactive">
              {detail.scoreboardFreezeMinutes !== undefined
                ? t("event_detail.freeze_current_minutes", {
                    minutes: detail.scoreboardFreezeMinutes,
                  })
                : t("event_detail.freeze_current_default")}
            </Box>
            <Input
              type="number"
              inputMode="numeric"
              placeholder={t("event_detail.freeze_placeholder")}
              value={freezeMinutesInput}
              onChange={({ detail: d }) => onUpdateFreezeMinutes(d.value)}
              disabled={!canMutateTenant || freezeMinutesInFlight}
            />
            <Button
              loading={freezeMinutesInFlight}
              disabled={!apiClient || !canMutateTenant || freezeMinutesInput.trim() === ""}
              onClick={onSaveFreezeMinutes}
            >
              {t("event_detail.freeze_save")}
            </Button>
          </SpaceBetween>
        </Field>
      </Box>
      <Box margin={{ top: "m" }}>
        {/* [ADR-047] 自動撤去予定時刻。 設定すると reconciler が時刻到来で bulk teardown を発火し、
            撤去し忘れによる課金リークを防ぐ。 即時撤去は別途「Event を削除」を使う。 */}
        <Field label={t("event_detail.teardown_at_label")}>
          <SpaceBetween size="xs">
            {detail.teardownAt ? (
              <code>{detail.teardownAt}</code>
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("event_detail.teardown_at_unset")}
              </Box>
            )}
            <Button
              onClick={onOpenTeardownModal}
              loading={teardownInFlight}
              disabled={!apiClient || !canMutateTenant || teardownInFlight}
            >
              {t("event_detail.teardown_at_pick")}
            </Button>
          </SpaceBetween>
        </Field>
      </Box>
    </Container>
  );
}
