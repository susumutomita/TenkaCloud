import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import type { AppConfig } from "../config";

/**
 * Issue #2696: Lite deploy オンボーディングドリルのチェックポイントコードを、 この
 * console が Lite mode で動いているときだけ返す。
 *
 * Lite mode の tenantId は "local" 固定で、frontend はこの値を公式 signal として
 * Lite を判定する。設定元は `infrastructure/lib/tenkacloud-lite/tenkacloud-lite-stack.ts`。
 * SaaS の pooled / silo tenant や demo mode (`tenantId: "demo-tenant"`) ではコードを
 * 出さない — ドリルは 「自分の AWS に Lite を立てた学習者」 への報酬表示であって、
 * 通常運用のイベント運営画面に出すノイズではないため。
 *
 * `competitorVerified` / `firstEventCreated` は「初回」を謳うマイルストーンだが、
 * verify / event 作成が成功するたびに毎回再表示されていた (2026-07-21 指摘)。
 * ブラウザの localStorage に一度表示した記録を残し、 2 回目以降は返さないようにする
 * (バックエンドの永続化は不要 — 単一ブラウザでのワンショット表示で十分)。
 */
const LITE_TENANT_ID = "local";
const SHOWN_STORAGE_PREFIX = "tenkacloud:lite-drill:shown:";

export type LiteDrillCheckpointKey = keyof typeof LITE_DRILL_CHECKPOINTS;

function shownStorageKey(checkpoint: LiteDrillCheckpointKey): string {
  return `${SHOWN_STORAGE_PREFIX}${checkpoint}`;
}

/** Whether this checkpoint's onboarding alert has already been shown once in this browser. */
export function hasLiteDrillCheckpointBeenShown(checkpoint: LiteDrillCheckpointKey): boolean {
  try {
    return window.localStorage.getItem(shownStorageKey(checkpoint)) !== null;
  } catch {
    // localStorage unavailable (private mode, SSR, etc.) — fail open so the drill still works.
    return false;
  }
}

/** Record that this checkpoint's onboarding alert has been shown, so it will not reappear. */
export function markLiteDrillCheckpointShown(checkpoint: LiteDrillCheckpointKey): void {
  try {
    window.localStorage.setItem(shownStorageKey(checkpoint), "1");
  } catch {
    // localStorage unavailable — worst case the alert can reappear next time, not a hard failure.
  }
}

export function liteDrillCheckpointCode(
  config: Pick<AppConfig, "tenantId">,
  checkpoint: LiteDrillCheckpointKey,
): string | undefined {
  if (config.tenantId !== LITE_TENANT_ID) return undefined;
  if (hasLiteDrillCheckpointBeenShown(checkpoint)) return undefined;
  return LITE_DRILL_CHECKPOINTS[checkpoint].code;
}
