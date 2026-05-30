import { DeployProgressPanel } from "../../components/event-detail/DeployProgressPanel";
import { EventChecklistPanel } from "../../components/event-detail/EventChecklistPanel";
import { EventPhaseBanner } from "../../components/event-detail/EventPhaseBanner";
import { EventReadinessPanel } from "../../components/event-detail/EventReadinessPanel";
import { EventWizardPanel } from "../../components/event-detail/EventWizardPanel";
import { ScoringLockPanel } from "../../components/event-detail/ScoringLockPanel";
import type { EventTabContentProps } from "./tab-content-props";

/**
 * Issue #1362: Qiita 「用途別グルーピング」 原則で Overview tab を 3 グループに整理。
 *
 *   1. 現状 (status)        — Event 概要 (ScoringLockPanel) + 現在のフェーズ
 *   2. 次のアクション (hero) — operator が押すべき button (EventWizardPanel の CTA half)
 *   3. リソース / Deploy 進捗 — チーム / 問題 / deployment 進捗
 *
 * `EventWizardPanel` 内部で「現状 (phase indicator)」 と「次のアクション (CTA)」 を別
 * Container に分割している (= 上の 1+2)。 視線は 画面 title → 現状 → 次のアクション →
 * リソース の順に降りていく。
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
      {/* Issue #1350: 4 項目の readiness check + 全 ✓ で 「準備完了」 大 badge */}
      <EventReadinessPanel
        completeCount={counts.completeCount}
        detail={detail}
        t={t}
        totalDeployCount={counts.totalDeployCount}
      />
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
      {/* Issue #1350: T-7 / T-1 / T-0 / T+0 phase 別 operator checklist */}
      <EventChecklistPanel t={t} />
    </>
  );
}
