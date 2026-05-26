/**
 * Issue #1350: Event-day operator checklist.
 *
 * Overview tab 下部に表示する 「T-7 / T-1 / T-0 / T+0 (= 開始後)」 の各フェーズの operator
 * 担当タスク列挙。 Cloudscape には専用 Checklist widget がないため、 ExpandableSection +
 * StatusIndicator (= pending/success) で同等 UI を組み立てる。
 *
 * Checklist の項目は固定 (= ベスト practice list)。 ユーザーが個別に check/uncheck できる
 * 必要は無く、 「これらを確認しろ」 と提示する read-only な runbook。 状態はサーバに保存しない
 * (= operator の頭の中の確認用 / 印刷不要)。 将来 「個別に check したい」 が出れば localStorage
 * 保管へ拡張する。
 *
 * フェーズ:
 *   - T-7 (1 週間前): 競技 account / role の verify、 problem set の確定、 team 招待開始
 *   - T-1 (前日): 全 deploy 完了確認、 team distribution、 開始時刻設定
 *   - T-0 (当日開始前): readiness panel 全 ✓ の確認、 開始通知準備
 *   - T+0 (= 開始後): 採点監視、 disruption alert 監視、 終了時の lock scoring
 */

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export type ChecklistPhaseId = "t_minus_7" | "t_minus_1" | "t_zero" | "t_plus_0";

interface ChecklistPhase {
  readonly id: ChecklistPhaseId;
  /** 各 phase で 3〜4 item を提示する。 i18n key の suffix idx は 1-origin。 */
  readonly itemCount: number;
}

const CHECKLIST_PHASES: readonly ChecklistPhase[] = [
  { id: "t_minus_7", itemCount: 4 },
  { id: "t_minus_1", itemCount: 4 },
  { id: "t_zero", itemCount: 4 },
  { id: "t_plus_0", itemCount: 4 },
];

export function EventChecklistPanel({ t }: { readonly t: Translate }) {
  return (
    <Container
      data-testid="event-checklist-panel"
      header={
        <Header variant="h2" description={t("event_detail.checklist_description")}>
          {t("event_detail.checklist_header")}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {CHECKLIST_PHASES.map((phase) => (
          <ExpandableSection
            key={phase.id}
            data-testid={`event-checklist-phase-${phase.id}`}
            variant="footer"
            defaultExpanded={phase.id === "t_zero"}
            headerText={t(`event_detail.checklist_phase_${phase.id}_label`)}
            headerDescription={t(`event_detail.checklist_phase_${phase.id}_subtitle`)}
          >
            <SpaceBetween size="xxs">
              {Array.from({ length: phase.itemCount }, (_, i) => i + 1).map((idx) => (
                <Box key={idx} data-testid={`event-checklist-item-${phase.id}-${idx}`}>
                  <Box variant="awsui-key-label" display="inline">
                    {`${idx}.`}
                  </Box>{" "}
                  {t(`event_detail.checklist_item_${phase.id}_${idx}`)}
                </Box>
              ))}
            </SpaceBetween>
          </ExpandableSection>
        ))}
      </SpaceBetween>
    </Container>
  );
}
