import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Fragment } from "react";
import type { EventDetail } from "../../api/events-client";
import { WIZARD_STEPS, type WizardState } from "../../lib/event-wizard";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #1362: Qiita 「用途別グルーピング」 原則に従い、 「現状 (phase indicator)」 と
 * 「次のアクション (CTA Alert)」 を別 container に分割。 上の Container は phase の現在地、
 * 下の Container は operator が押すべき button への誘導 (= 視線の一等地)。
 *
 * 旧版は phase indicator + CTA を 1 container に詰めていたが、 「次のアクション」 タイトルが
 * Alert 内部に埋もれて 画面 title > グループ title > データ の階層感が出なかった。
 */
export function EventWizardPanel({
  t,
  wizard,
}: {
  readonly t: Translate;
  readonly wizard: WizardState;
}) {
  return (
    <SpaceBetween size="l">
      <Container
        data-testid="event-overview-phase-container"
        header={
          <Header variant="h2" description={t("event_detail.phase_description")}>
            {t("event_detail.phase_header")}
          </Header>
        }
      >
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
      </Container>
      <Container
        data-testid="event-overview-next-action-container"
        header={
          <Header variant="h2" description={t("event_detail.next_action_description")}>
            {t("event_detail.next_action")}
          </Header>
        }
      >
        <Alert type={wizard.alertType} statusIconAriaLabel={wizard.alertType}>
          {wizard.cta}
        </Alert>
      </Container>
    </SpaceBetween>
  );
}

/**
 * Issue #1318: TEARDOWN 状態の Event を rescue する Force ARCHIVED panel。
 *
 * 元々 EventWizardPanel と一体だったが、 tabs 構造 (Overview / Operations) に分割した際に
 * 「rescue 系は Operations tab に集約」 の方針 (= 普段使わない高度操作を分離) に従い独立 component
 * として切り出した。 status が TEARDOWN のときだけ Alert を表示する (= 非該当 status では null)。
 */
export function EventRescuePanel({
  detail,
  forceArchiveInFlight,
  onForceArchive,
  t,
}: {
  readonly detail: EventDetail;
  readonly forceArchiveInFlight: boolean;
  readonly onForceArchive: () => void;
  readonly t: Translate;
}) {
  if (detail.status !== "TEARDOWN") return null;
  return (
    <Alert
      type="warning"
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
  );
}
