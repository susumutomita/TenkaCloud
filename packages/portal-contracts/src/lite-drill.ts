/**
 * Issue #2696: 「自分の TenkaCloud Lite を立てる」 オンボーディングドリルの
 * チェックポイント契約。
 *
 * LP デモポータル (= participant-portal dev-mock mode) に固定出題されるドリルで、
 * 学習者が **実際に** 自分の AWS アカウントへ Lite mode を deploy → Competitor
 * アカウント検証 → 初回イベント作成、 と進むたびに実環境の各サーフェスへ印字される
 * チェックポイントコードを demo portal へ提出して得点する。
 *
 * コードの印字箇所 (= 学習者がその手順を実行しないと画面に出ない場所):
 *   - launcherCreated    → `infrastructure/templates/lite-pipeline.yaml` の CFn Outputs
 *   - deployComplete     → `scripts/tenkacloud-lite.ts` の post-deploy guide (CodeBuild ログ末尾)
 *   - competitorVerified → Application Admin Console の Competitor Accounts 検証成功 Alert (Lite のみ)
 *   - firstEventCreated  → Application Admin Console の Event 作成成功 modal (Lite のみ)
 *   - cleanupComplete    → launcher CodeBuild の `make destroy` 成功直後のログ
 *
 * これは競技問題の flag ではなく **意図的に公開** する
 * オンボーディング用チェックポイント (repo を grep すれば見える)。 デプロイの暗号学的
 * 証明ではなく 「手順を踏まないと画面に出ない値の確認」 であり、 競技スコアには使わない。
 * cleanupComplete が観測するのは Lite 本体の destroy 成功までで、 その後の launcher 削除は
 * 技術的に観測できないため学習者の自己確認。 判定は demo portal のクライアント側に閉じる。
 */

export const LITE_DRILL_PROBLEM_ID = "deploy-tenkacloud-lite";
export const LITE_CLEANUP_DRILL_PROBLEM_ID = "cleanup-tenkacloud-lite";

export interface LiteDrillCheckpoint {
  /** dev-mock team view の multi-flag sub-flag id (= 提出欄の対応付け)。 */
  readonly flagId: string;
  /** 実環境の該当サーフェスに印字される提出コード。 */
  readonly code: string;
}

export const LITE_DRILL_CHECKPOINTS = {
  launcherCreated: {
    flagId: "launcher-created",
    code: "TC{LITE-LAUNCHER-READY}",
  },
  deployComplete: {
    flagId: "deploy-complete",
    code: "TC{LITE-DEPLOY-COMPLETE}",
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

/**
 * `ACTION=destroy` が成功した CodeBuild ログにだけ印字する、片付け問題用の
 * チェックポイント。launcher スタックを削除する前に控え、削除後に提出する。
 */
export const LITE_CLEANUP_DRILL_CHECKPOINT = {
  flagId: "cleanup-complete",
  code: "TC{LITE-CLEANUP-COMPLETE}",
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
    matchesCheckpointCode(LITE_CLEANUP_DRILL_CHECKPOINT.code, submitted)
  );
}
