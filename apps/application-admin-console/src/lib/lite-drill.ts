import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import type { AppConfig } from "../config";

/**
 * Issue #2696: Lite deploy オンボーディングドリルのチェックポイントコードを、 この
 * console が Lite mode で動いているときだけ返す。
 *
 * Lite mode (ADR-016) は tenantId="local" 固定で、 これは frontend が Lite を判定する
 * ための公式 signal (= `infrastructure/lib/tenkacloud-lite/tenkacloud-lite-stack.ts`)。
 * SaaS の pooled / silo tenant や demo mode (`tenantId: "demo-tenant"`) ではコードを
 * 出さない — ドリルは 「自分の AWS に Lite を立てた学習者」 への報酬表示であって、
 * 通常運用のイベント運営画面に出すノイズではないため。
 */
const LITE_TENANT_ID = "local";

export type LiteDrillCheckpointKey = keyof typeof LITE_DRILL_CHECKPOINTS;

export function liteDrillCheckpointCode(
  config: Pick<AppConfig, "tenantId">,
  checkpoint: LiteDrillCheckpointKey,
): string | undefined {
  if (config.tenantId !== LITE_TENANT_ID) return undefined;
  return LITE_DRILL_CHECKPOINTS[checkpoint].code;
}
