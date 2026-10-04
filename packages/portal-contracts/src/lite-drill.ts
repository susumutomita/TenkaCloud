/**
 * Cloud onboarding demo evidence. Compatibility problem/flag identifiers stay fixed.
 * Launcher and organizer-screen codes remain available on their respective screens.
 * Deployment and cleanup accept the current cloud CLI success message, not legacy codes.
 * This client-side teaching check does not independently verify AWS resources or launcher deletion.
 */

export const LITE_DRILL_PROBLEM_ID = "deploy-tenkacloud-lite";
export const LITE_CLEANUP_DRILL_PROBLEM_ID = "cleanup-tenkacloud-lite";

export interface LiteDrillCheckpoint {
  /** dev-mock team view の multi-flag sub-flag id (= 提出欄の対応付け)。 */
  readonly flagId: string;
  /** 実環境の該当サーフェスに印字される提出値。 */
  readonly code: string;
}

export const LITE_DRILL_CHECKPOINTS = {
  launcherCreated: {
    flagId: "launcher-created",
    code: "TC{LITE-LAUNCHER-READY}",
  },
  deployComplete: {
    flagId: "deploy-complete",
    code: "Cloud competition hosting deployed.",
  },
  competitorVerified: {
    flagId: "competitor-verified",
    code: "TC{COMPETITOR-TRUST-OK}",
  },
  firstEventCreated: {
    flagId: "first-event-created",
    code: "TC{FIRST-EVENT-LIVE}",
  },
} as const satisfies Record<string, LiteDrillCheckpoint>;

/** Current CLI teardown success line. Confirm remaining resources and launcher deletion separately. */
export const LITE_CLEANUP_DRILL_CHECKPOINT = {
  flagId: "cleanup-complete",
  code: "Cloud platform stacks destroyed.",
} as const satisfies LiteDrillCheckpoint;

/** ドリルの sub-flag id → 期待コード。 未知の id は undefined (= caller 側で fallback)。 */
export function findLiteDrillCheckpointCode(flagId: string): string | undefined {
  return Object.values(LITE_DRILL_CHECKPOINTS).find((c) => c.flagId === flagId)?.code;
}

/**
 * 提出値がチェックポイントコードと一致するか。 前後の空白・大文字小文字・連続空白は
 * 許容する (= 初見者のコピー&ペースト揺れで弾かない。 `make local` のような複数語の
 * コードでも二重スペース等で弾かれないよう、 内部の連続空白も 1 個へ畳む)。
 * lite / local の両ドリルが共用する。
 */
export function matchesCheckpointCode(code: string, submitted: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
  return normalize(submitted) === normalize(code);
}

/** 提出値が lite ドリルの該当チェックポイントと一致するか。 未知の flagId は常に false。 */
export function matchesLiteDrillCheckpoint(flagId: string, submitted: string): boolean {
  const code = findLiteDrillCheckpointCode(flagId);
  if (!code) return false;
  return matchesCheckpointCode(code, submitted);
}

/** クリーンアップ問題のチェックポイントと一致するか。 */
export function matchesLiteCleanupDrillCheckpoint(flagId: string, submitted: string): boolean {
  return (
    flagId === LITE_CLEANUP_DRILL_CHECKPOINT.flagId &&
    (matchesCheckpointCode(LITE_CLEANUP_DRILL_CHECKPOINT.code, submitted) ||
      matchesCheckpointCode(
        "Cloud platform stacks destroyed. Existing deployed Retain policies may leave chargeable resources; review the saved plan. This teardown removes external Turso rows only for explicit destroy-all when the deployed provider identity is verified.",
        submitted,
      ))
  );
}
