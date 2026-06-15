import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { EventDetail } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventNotificationsPanel({
  canMutateTenant,
  detail,
  onOpen,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly onOpen: () => void;
  readonly t: Translate;
}) {
  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("event_detail.notifications_description")}
          actions={
            <Button
              variant="primary"
              iconName="notification"
              disabled={
                detail.status === "DRAFT" ||
                detail.status === "TEARDOWN" ||
                detail.status === "ARCHIVED" ||
                !canMutateTenant
              }
              onClick={onOpen}
            >
              {t("event_detail.notifications_send")}
            </Button>
          }
        >
          {t("event_detail.notifications_header")}
        </Header>
      }
    >
      <SpaceBetween size="s">
        <Box variant="small" color="text-status-inactive">
          {t("event_detail.notifications_hint")}
        </Box>
        {detail.status === "DRAFT" && (
          <Alert type="info">{t("event_detail.notifications_draft_disabled")}</Alert>
        )}
        {(detail.status === "TEARDOWN" || detail.status === "ARCHIVED") && (
          <Alert type="info">
            {detail.status === "TEARDOWN"
              ? t("event_detail.notifications_teardown_disabled_teardown")
              : t("event_detail.notifications_teardown_disabled_archived")}
          </Alert>
        )}
      </SpaceBetween>
    </Container>
  );
}
