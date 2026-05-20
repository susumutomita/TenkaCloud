import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { EventDetail } from "../../api/events-client";
import { Field, STATUS_COLOR } from "./shared";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function ScoringLockPanel({
  detail,
  t,
}: {
  readonly detail: EventDetail;
  readonly t: Translate;
}) {
  return (
    <Container header={<Header variant="h2">{t("event_detail.event_summary_header")}</Header>}>
      <SpaceBetween size="m">
        {detail.scoringLocked === true && (
          <Alert
            type="warning"
            statusIconAriaLabel="scoring locked"
            header={t("event_detail.scoring_locked_header")}
          >
            {t("event_detail.scoring_locked_body")}
            {detail.scoringLockedAt &&
              ` ${t("event_detail.scoring_locked_locked_at", { at: detail.scoringLockedAt })}`}
          </Alert>
        )}
        <ColumnLayout columns={4} variant="text-grid">
          <Field label={t("event_detail.field_status")}>
            <SpaceBetween direction="horizontal" size="xxs">
              <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>
              {detail.scoringLocked === true && (
                <Badge color="red">{t("event_detail.scoring_locked_badge")}</Badge>
              )}
            </SpaceBetween>
          </Field>
          <Field label={t("event_detail.field_team_count")}>{detail.teamCount}</Field>
          <Field label={t("event_detail.field_problem_count")}>{detail.problems.length}</Field>
          <Field label={t("event_detail.field_created_at")}>{detail.createdAt}</Field>
        </ColumnLayout>
      </SpaceBetween>
    </Container>
  );
}
