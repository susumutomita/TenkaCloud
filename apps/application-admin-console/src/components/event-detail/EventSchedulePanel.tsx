import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import type { BulkDeployBody, EventDetail } from "../../api/events-client";
import { isTerminalEventStatus } from "../../lib/effective-event-status";
import type { WizardState } from "../../lib/event-wizard";
import { Field, scoringBadge } from "./shared";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * デプロイ / 撤去 のライフサイクル操作 (予約 = 日時指定 + 即座に) をまとめた section。
 *
 * starts/ends の「予約 + 即座に」と同型のペア UI を deploy / teardown にも揃え、 散らばっていた
 * header Deploy / 高度操作 tab の teardown を「スケジュール」tab に一本化する。 即座にデプロイは
 * 未デプロイなら直接 onBulkDeploy、 全 (team × problem) がデプロイ済みなら force-redeploy の
 * confirm modal を挟む。 即座に撤去は danger-zone の DELETE-confirm modal を開く onConfirmTeardown
 * を叩く。 親 (EventSchedulePanel) の cognitive complexity を抑えるためここに切り出している。
 */
function DeployTeardownFields({
  apiClient,
  bulkInFlight,
  canMutateTenant,
  completeCount,
  deployScheduleInFlight,
  detail,
  onBulkDeploy,
  onConfirmTeardown,
  onOpenDeployModal,
  onOpenTeardownModal,
  teardownInFlight,
  totalDeployCount,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly bulkInFlight: "deploy" | "teardown" | "retry-failed" | "redeploy" | null;
  readonly canMutateTenant: boolean;
  readonly completeCount: number;
  readonly deployScheduleInFlight: boolean;
  readonly detail: EventDetail;
  readonly onBulkDeploy: (body?: BulkDeployBody) => void;
  readonly onConfirmTeardown: () => void;
  readonly onOpenDeployModal: () => void;
  readonly onOpenTeardownModal: () => void;
  readonly teardownInFlight: boolean;
  readonly totalDeployCount: number;
  readonly t: Translate;
  readonly wizard: WizardState | null;
}) {
  // 即座にデプロイ: 未デプロイのペアが残っていれば通常デプロイ (非破壊・確認なし)。 全 (team × problem)
  // ペアがデプロイ済みなら押下を「強制再デプロイ」 (既存 stack を再作成する破壊的操作) とみなし confirm
  // modal を挟む (= 旧 header Deploy button の挙動を Schedule tab に移設)。
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const closeRedeploy = () => setConfirmRedeploy(false);
  const expectedDeployCount = detail.teams.length * detail.problems.length;
  const allDeployed = expectedDeployCount > 0 && totalDeployCount >= expectedDeployCount;
  // 予約デプロイ (deployAt) は reconciler が DRAFT (未デプロイ) でしか発火しない (deploy 済 event の
  // 自動再 deploy = 進行中 stack 再作成を防ぐため)。 deploy 後に予約時刻を設定させると永久に発火しない
  // 「死に設定」になり、 endsAt 比較の 400 まで誘発して混乱するので、 予約 UI は DRAFT 限定にする。
  const isDraft = detail.status === "DRAFT";
  const deployNowDisabled =
    !apiClient ||
    !canMutateTenant ||
    detail.problems.length === 0 ||
    detail.teams.length === 0 ||
    isTerminalEventStatus(detail.status) ||
    bulkInFlight !== null;
  return (
    <>
      <Box margin={{ top: "m" }}>
        {/* 自動デプロイ予定時刻。 設定すると reconciler が時刻到来で DRAFT event を
            bulk deploy し、 開始直前の手動 deploy 操作を不要にする。 即時 deploy は「即座にデプロイ」を使う。 */}
        <Field label={t("event_detail.deploy_at_label")}>
          <SpaceBetween size="xs">
            {isDraft ? (
              detail.deployAt ? (
                <code>{detail.deployAt}</code>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  {t("event_detail.deploy_at_unset")}
                </Box>
              )
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("event_detail.deploy_at_after_deploy_hint")}
              </Box>
            )}
            <SpaceBetween direction="horizontal" size="xs">
              {isDraft && (
                <Button
                  onClick={onOpenDeployModal}
                  loading={deployScheduleInFlight}
                  disabled={!apiClient || !canMutateTenant || deployScheduleInFlight}
                >
                  {t("event_detail.deploy_at_pick")}
                </Button>
              )}
              <Button
                // 全デプロイ済みでの押下は破壊的 force-redeploy。 推奨アクション (primary) として
                // 強調せず、 ラベルも「強制再デプロイ」にして無害な初回デプロイに見えないようにする。
                variant={wizard?.primary === "deploy" && !allDeployed ? "primary" : "normal"}
                loading={bulkInFlight === "deploy" || bulkInFlight === "redeploy"}
                disabled={deployNowDisabled}
                onClick={() => (allDeployed ? setConfirmRedeploy(true) : onBulkDeploy())}
              >
                {t(allDeployed ? "event_detail.deploy_at_redeploy" : "event_detail.deploy_at_now")}
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Field>
      </Box>
      <Box margin={{ top: "m" }}>
        {/* 自動撤去予定時刻。 設定すると reconciler が時刻到来で bulk teardown を発火し、
            撤去し忘れによる課金リークを防ぐ。 即時撤去は「即座に撤去」を使う。 */}
        <Field label={t("event_detail.teardown_at_label")}>
          <SpaceBetween size="xs">
            {detail.teardownAt ? (
              <code>{detail.teardownAt}</code>
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("event_detail.teardown_at_unset")}
              </Box>
            )}
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={onOpenTeardownModal}
                loading={teardownInFlight}
                disabled={!apiClient || !canMutateTenant || teardownInFlight}
              >
                {t("event_detail.teardown_at_pick")}
              </Button>
              {/* 即座に撤去: danger-zone の DELETE-confirm modal を開く (= 破壊的 teardown は
                  確認入力を挟む)。 in-flight 表示は bulkInFlight="teardown" を共有する。 */}
              <Button
                loading={bulkInFlight === "teardown"}
                disabled={!apiClient || !canMutateTenant || bulkInFlight !== null}
                onClick={onConfirmTeardown}
              >
                {t("event_detail.teardown_at_now")}
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Field>
      </Box>

      {confirmRedeploy && (
        <Modal
          visible
          header={t("event_detail.modal_redeploy_header")}
          onDismiss={closeRedeploy}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={closeRedeploy}>{t("event_detail.modal_cancel")}</Button>
                <Button
                  variant="primary"
                  loading={bulkInFlight === "redeploy"}
                  disabled={!canMutateTenant}
                  onClick={() => {
                    onBulkDeploy({ forceRedeploy: true });
                    closeRedeploy();
                  }}
                >
                  {t("event_detail.modal_redeploy_confirm")}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {t("event_detail.modal_redeploy_body", { count: completeCount })}
        </Modal>
      )}
    </>
  );
}

export function EventSchedulePanel({
  apiClient,
  bulkInFlight,
  canMutateTenant,
  completeCount,
  deployScheduleInFlight,
  detail,
  endsAtInFlight,
  freezeMinutesInFlight,
  freezeMinutesInput,
  onBulkDeploy,
  onConfirmTeardown,
  onEndNowSchedule,
  onOpenDeployModal,
  onOpenEndsAtModal,
  onOpenScheduleModal,
  onOpenTeardownModal,
  onSaveFreezeMinutes,
  onStartNow,
  onUpdateFreezeMinutes,
  scheduleInFlight,
  teardownInFlight,
  totalDeployCount,
  t,
  wizard,
}: {
  readonly apiClient: ApiClient | null;
  readonly bulkInFlight: "deploy" | "teardown" | "retry-failed" | "redeploy" | null;
  readonly canMutateTenant: boolean;
  readonly completeCount: number;
  readonly deployScheduleInFlight: boolean;
  readonly detail: EventDetail;
  readonly endsAtInFlight: boolean;
  readonly freezeMinutesInFlight: boolean;
  readonly freezeMinutesInput: string;
  readonly onBulkDeploy: (body?: BulkDeployBody) => void;
  readonly onConfirmTeardown: () => void;
  readonly onEndNowSchedule: () => void;
  readonly onOpenDeployModal: () => void;
  readonly onOpenEndsAtModal: () => void;
  readonly onOpenScheduleModal: () => void;
  readonly onOpenTeardownModal: () => void;
  readonly onSaveFreezeMinutes: () => void;
  readonly onStartNow: () => void;
  readonly onUpdateFreezeMinutes: (value: string) => void;
  readonly scheduleInFlight: "now" | "scheduled" | null;
  readonly teardownInFlight: boolean;
  /** これまでに作成された deployment 行の総数 (全 team × problem ペアが揃ったかの判定用)。 */
  readonly totalDeployCount: number;
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
      <DeployTeardownFields
        apiClient={apiClient}
        bulkInFlight={bulkInFlight}
        canMutateTenant={canMutateTenant}
        completeCount={completeCount}
        deployScheduleInFlight={deployScheduleInFlight}
        detail={detail}
        onBulkDeploy={onBulkDeploy}
        onConfirmTeardown={onConfirmTeardown}
        onOpenDeployModal={onOpenDeployModal}
        onOpenTeardownModal={onOpenTeardownModal}
        teardownInFlight={teardownInFlight}
        totalDeployCount={totalDeployCount}
        t={t}
        wizard={wizard}
      />
    </Container>
  );
}
