/**
 * Issue #2707: 「ローカルモードで遊ぶ」 オンボーディングドリルのチェックポイント契約。
 *
 * LP デモポータルの 3 部作 (理解 → ローカル → Lite) の 2 問目。 学習者が Codespaces
 * (または `make local`) でローカルプレイを起動し、 固定入門ドリル hello-world
 * (#2702) で初得点すると、 ローカルポータルの writeup 末尾にチェックポイントコード
 * が現れる (`scripts/local-play/api-views.ts` が付加する)。 それを demo portal に
 * 提出して得点する。
 *
 * lite-drill と同じく **意図的に公開** のオンボーディング用コード (競技 flag ではない)。
 */

import type { LiteDrillCheckpoint } from "./lite-drill.js";
import { matchesCheckpointCode } from "./lite-drill.js";

export const LOCAL_DRILL_PROBLEM_ID = "play-local-mode";

/** hello-world 初得点で writeup に現れるチェックポイント。 */
export const LOCAL_DRILL_FIRST_SCORE = {
  flagId: "first-score",
  code: "TENKA{LOCAL-FIRST-SCORE}",
} as const satisfies LiteDrillCheckpoint;

/** 提出値が「ローカル初得点」チェックポイントと一致するか (空白・大文字小文字は許容)。 */
export function matchesLocalDrillFirstScore(submitted: string): boolean {
  return matchesCheckpointCode(LOCAL_DRILL_FIRST_SCORE.code, submitted);
}
