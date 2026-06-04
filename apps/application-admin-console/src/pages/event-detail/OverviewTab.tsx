import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventPhaseBanner } from "../../components/event-detail/EventPhaseBanner";
import { EventWizardPanel } from "../../components/event-detail/EventWizardPanel";
import { ScoringLockPanel } from "../../components/event-detail/ScoringLockPanel";
import type { EventTabContentProps } from "./tab-content-props";

/**
 * Overview tab. 上から: phase 帯 (Setup/Live/Teardown) → Event 概要 (status/teams/problems)
 * → 現在のフェーズ (lifecycle 上の現在位置) → Deploy 進捗。
 *
 * 「Event 準備状況」 (readiness checklist) と 「次のアクション」 (CTA) は、 現在のフェーズ
 * indicator が示す情報と重複していたため削除。 Deploy 進捗は phase indicator の直下に置き、
 * 「今どの step にいるか」 と 「その deploy がどこまで進んだか」 を隣接させる。
 */
export function OverviewTab({
  counts,
  detail,
  manualRefresh,
  manualRefreshInFlight,
  t,
  wizard,
}: EventTabContentProps) {
  return (
    <>
      {/* Issue #1350: Setup / Live / Teardown の phase 帯を冒頭に表示 (色 cue) */}
      <EventPhaseBanner detail={detail} t={t} />
      <ScoringLockPanel detail={detail} t={t} />
      <EventWizardPanel t={t} wizard={wizard} />
      <DeployProgressPanel
        allDoneCount={counts.allDoneCount}
        completeCount={counts.completeCount}
        failedCount={counts.failedCount}
        inFlightCount={counts.inFlightCount}
        manualRefreshInFlight={manualRefreshInFlight}
        onManualRefresh={manualRefresh}
        t={t}
        totalDeployCount={counts.totalDeployCount}
      />
    </>
  );
}
