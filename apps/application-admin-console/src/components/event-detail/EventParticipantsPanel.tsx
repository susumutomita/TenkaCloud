import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventParticipantsPanel({
  config,
  detail,
  t,
}: {
  readonly config: AppConfig;
  readonly detail: EventDetail;
  readonly t: Translate;
}) {
  return (
    <ExpandableSection
      variant="container"
      defaultExpanded={
        detail.status === "DRAFT" || detail.status === "DEPLOYING" || detail.status === "READY"
      }
      headerText={t("event_detail.participants_header")}
    >
      <SpaceBetween size="m">
        {config.participantPortalUrl ? (
          <ColumnLayout columns={2} variant="text-grid">
            <Box>
              <Box variant="awsui-key-label">{t("event_detail.participants_portal_url")}</Box>
              <SpaceBetween direction="horizontal" size="xs">
                <a href={config.participantPortalUrl} target="_blank" rel="noreferrer noopener">
                  <code>{config.participantPortalUrl}</code>
                </a>
                <Button
                  iconName="copy"
                  ariaLabel={t("event_detail.participants_copy_aria")}
                  onClick={() =>
                    // この closure は participantPortalUrl truthy 時のみ render されるので
                    // ?? "" の右辺は不到達 (property narrowing 用の型ガード)。
                    /* v8 ignore next */
                    void navigator.clipboard?.writeText(config.participantPortalUrl ?? "")
                  }
                >
                  {t("event_detail.participants_copy")}
                </Button>
              </SpaceBetween>
            </Box>
            <Box>
              <Box variant="awsui-key-label">{t("event_detail.participants_steps_header")}</Box>
              <Box variant="small">
                1. {t("event_detail.participants_step_1")}
                <br />
                2. {t("event_detail.participants_step_2")}
                <br />
                3. {t("event_detail.participants_step_3")}
                <br />
                4. {t("event_detail.participants_step_4")}
              </Box>
            </Box>
          </ColumnLayout>
        ) : (
          <Alert type="info" header={t("event_detail.participants_no_url_header")}>
            {t("event_detail.participants_no_url_body")}
          </Alert>
        )}
      </SpaceBetween>
    </ExpandableSection>
  );
}
