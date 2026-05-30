/**
 * Issue #1350: Event の phase (Setup / Live / Teardown) を一目で識別する banner。
 *
 * effective status (= startsAt/endsAt を考慮した 動的 status) から phase を導出し、 banner を
 * 描画する:
 *
 *   - Setup phase (DRAFT / DEPLOYING / READY pre-start): yellow tint Alert
 *   - Live phase (RUNNING): green tint Alert + 「競技中」 大 timer
 *   - Teardown phase (ENDED / TEARDOWN / ARCHIVED): grey tint Alert
 *
 * 既存の `EventWizardPanel` Alert と同居するが、 こちらは色付きの phase 帯。 wizard は次の
 * action を提示するもので、 視覚的 phase 識別は banner が担当する (= 役割が違う)。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { EventDetail } from "../../api/events-client";
import { computeEffectiveStatus, type EffectiveStatus } from "../../lib/effective-event-status";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export type EventPhase = "setup" | "live" | "teardown";

/**
 * effective status → phase mapping。
 *
 * DRAFT / DEPLOYING / READY (= startsAt 未満 or 未設定) → setup
 * RUNNING → live
 * ENDED / TEARDOWN / ARCHIVED → teardown
 */
export function effectiveStatusToPhase(status: EffectiveStatus): EventPhase {
  if (status === "RUNNING") return "live";
  if (status === "ENDED" || status === "TEARDOWN" || status === "ARCHIVED") return "teardown";
  return "setup";
}

/** Live phase で表示する大型 elapsed timer (= H:MM:SS)。 純粋関数でテスト可能。 */
export function formatElapsed(startMs: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function EventPhaseBanner({
  detail,
  now,
  t,
}: {
  readonly detail: EventDetail;
  /** test 注入用。 default は new Date()。 */
  readonly now?: Date;
  readonly t: Translate;
}) {
  const effective = computeEffectiveStatus(
    {
      status: detail.status,
      startsAt: detail.startsAt ?? null,
      endsAt: detail.endsAt ?? null,
    },
    now ?? new Date(),
  );
  const phase = effectiveStatusToPhase(effective);
  if (phase === "live") {
    // effective===RUNNING は computeEffectiveStatus rule 4 (READY + 過去 startsAt) からのみ
    // 来るため、 ここで detail.startsAt は常に有効な過去日。 startMs が NaN になる経路は無く、
    // 下の NaN / "—" fallback は到達不能な防御 (= coverage から除外)。
    const nowMs = (now ?? new Date()).getTime();
    /* v8 ignore next -- 到達不能: startsAt は live 時点で常に有効 (NaN 経路なし) */
    const startMs = detail.startsAt ? new Date(detail.startsAt).getTime() : NaN;
    /* v8 ignore next -- 同上 ("—" fallback は不到達) */
    const elapsed = Number.isFinite(startMs) ? formatElapsed(startMs, nowMs) : "—";
    return (
      <Alert
        type="success"
        data-testid={`event-phase-banner-${phase}`}
        header={t("event_detail.phase_banner_live_header")}
      >
        <SpaceBetween size="xxs">
          <Box>{t("event_detail.phase_banner_live_body")}</Box>
          <Box
            variant="awsui-key-label"
            fontSize="display-l"
            data-testid="event-phase-banner-live-timer"
          >
            {elapsed}
          </Box>
        </SpaceBetween>
      </Alert>
    );
  }
  if (phase === "teardown") {
    return (
      <Alert
        type="info"
        data-testid={`event-phase-banner-${phase}`}
        header={t("event_detail.phase_banner_teardown_header")}
      >
        {t("event_detail.phase_banner_teardown_body")}
      </Alert>
    );
  }
  // setup
  return (
    <Alert
      type="warning"
      data-testid={`event-phase-banner-${phase}`}
      header={t("event_detail.phase_banner_setup_header")}
    >
      {t("event_detail.phase_banner_setup_body")}
    </Alert>
  );
}
