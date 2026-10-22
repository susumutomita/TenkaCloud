import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import RadioGroup from "@cloudscape-design/components/radio-group";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import {
  defaultMatchLength,
  MATCH_LENGTH_PRESETS,
  type MatchLengthChoice,
  resolveMatchLength,
} from "../../hooks/event-operations-validation";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * [Issue #3453] Start now asks how long the competition runs. Mounted per opening, so every
 * opening starts from the event's default instead of the previous choice.
 */
export function StartNowModal({
  canMutateTenant,
  coordinationBattle,
  onDismiss,
  onStart,
  reservedEndsAt,
  t,
}: {
  readonly canMutateTenant: boolean;
  /** The event includes a problem that declares interTeamCoordination. */
  readonly coordinationBattle: boolean;
  readonly onDismiss: () => void;
  /** Called with no length when the organizer keeps the reserved end or starts without one. */
  readonly onStart: (durationMinutes?: number) => void;
  /** An end reserved before start; starting without a length keeps it, so "no end" is not offered. */
  readonly reservedEndsAt?: string;
  readonly t: Translate;
}) {
  const [choice, setChoice] = useState<MatchLengthChoice>(
    defaultMatchLength(coordinationBattle, reservedEndsAt !== undefined),
  );
  const [customMinutes, setCustomMinutes] = useState("");
  const resolved = resolveMatchLength(choice, customMinutes);
  const customError =
    choice === "custom" && customMinutes.trim() !== "" && !resolved.ok
      ? t(resolved.errorKey)
      : undefined;
  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header={t("event_detail.start_now_header")}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              disabled={!canMutateTenant || !resolved.ok}
              onClick={() => {
                if (resolved.ok) onStart(resolved.durationMinutes);
              }}
            >
              {t("event_detail.start_now_confirm")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box>{t("event_detail.start_now_body")}</Box>
        <FormField label={t("event_detail.start_now_length_label")}>
          <RadioGroup
            value={choice}
            onChange={({ detail }) => setChoice(detail.value as MatchLengthChoice)}
            items={[
              ...MATCH_LENGTH_PRESETS.map((minutes) => ({
                value: String(minutes),
                label: t("event_detail.start_now_length_minutes", { minutes }),
              })),
              { value: "custom", label: t("event_detail.start_now_length_custom") },
              reservedEndsAt === undefined
                ? {
                    value: "none",
                    label: t("event_detail.start_now_length_none"),
                    description: t("event_detail.start_now_length_none_description"),
                  }
                : {
                    value: "keep",
                    label: t("event_detail.start_now_length_keep"),
                    description: t("event_detail.start_now_length_keep_description", {
                      endsAt: reservedEndsAt,
                    }),
                  },
            ]}
          />
        </FormField>
        {choice === "custom" && (
          <FormField
            label={t("event_detail.start_now_custom_label")}
            constraintText={t("event_detail.start_now_custom_constraint")}
            errorText={customError}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={customMinutes}
              invalid={customError !== undefined}
              onChange={({ detail }) => setCustomMinutes(detail.value)}
            />
          </FormField>
        )}
      </SpaceBetween>
    </Modal>
  );
}
