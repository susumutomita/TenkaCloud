import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Fragment } from "react";
import type { EventDetail } from "../../api/events-client";
import { WIZARD_STEPS, type WizardState } from "../../lib/event-wizard";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventWizardPanel({
  detail,
  forceArchiveInFlight,
  onForceArchive,
  t,
  wizard,
}: {
  readonly detail: EventDetail;
  readonly forceArchiveInFlight: boolean;
  readonly onForceArchive: () => void;
  readonly t: Translate;
  readonly wizard: WizardState;
}) {
  return (
    <Container>
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          {WIZARD_STEPS.map((step, i) => (
            <Fragment key={step.key}>
              {i > 0 && (
                <Box color="text-status-inactive" variant="small">
                  →
                </Box>
              )}
              <Badge
                color={i < wizard.stepIndex ? "green" : i === wizard.stepIndex ? "blue" : "grey"}
              >
                {i + 1}. {step.label}
              </Badge>
            </Fragment>
          ))}
        </SpaceBetween>
        <Alert type={wizard.alertType} header={t("event_detail.next_action")}>
          {wizard.cta}
        </Alert>
        {detail.status === "TEARDOWN" && (
          <Alert
            type="info"
            header={t("event_detail.rescue_header")}
            action={
              <Button
                loading={forceArchiveInFlight}
                onClick={onForceArchive}
                data-testid="force-archive-button"
              >
                {t("event_detail.rescue_force_archive")}
              </Button>
            }
          >
            {t("event_detail.rescue_body")}
          </Alert>
        )}
      </SpaceBetween>
    </Container>
  );
}
