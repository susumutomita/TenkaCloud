/**
 * Issue #2707: 「ローカルモードで遊ぶ」 オンボーディングドリルのチェックポイント契約。
 *
 * LP デモポータルの 3 部作 (理解 → ローカル → Lite) の 2 問目。 学習者が Codespaces
 * (または `make local`) でローカルプレイを実際に起動したことの証明として、 起動コマンド
 * そのもの (`make local`) を demo portal へ提出して得点する。
 *
 * 当初は固定入門ドリル sqli-demo の初クリアで writeup 末尾に現れるチェックポイント
 * コードを提出する設計だったが、 「ローカルモードを起動できたか」 の確認に
 * セキュリティ問題を 1 問解く要求を挟むのは checkpoint 1 (Portal port) と趣旨が
 * 重複するうえ手順として重い、 という判断で起動コマンド自体の入力に単純化した
 * (2026-07-21)。 sqli-demo は普通の local-play 問題として引き続き遊べるが、 この
 * チェックポイントとはもう連動しない。
 *
 * lite-drill と同じく **意図的に公開** のオンボーディング用コード (競技 flag ではない)。
 */

import type { LiteDrillCheckpoint } from "./lite-drill.js";
import { matchesCheckpointCode } from "./lite-drill.js";

export const LOCAL_DRILL_PROBLEM_ID = "play-local-mode";

/** ローカルモードを起動したコマンド。 checkpoint 2 の正解 (代表例。 実際は複数の書き方を許容する)。 */
export const LOCAL_DRILL_LAUNCH_COMMAND = {
  flagId: "first-score",
  code: "make local",
} as const satisfies LiteDrillCheckpoint;

/**
 * 実際に checkpoint 1 (Portal port) を満たせる = portal ごと起動する書き方をすべて許容する。
 * `make local-up` はポータルを起動しない API-only escape hatch (Makefile) なので、
 * このドリルの正解には含めない。
 */
const ACCEPTED_LAUNCH_COMMANDS = [
  LOCAL_DRILL_LAUNCH_COMMAND.code,
  "tenkacloud local",
  "bun run tenkacloud local",
] as const;

/** 提出値が「ローカルモード起動コマンド」チェックポイントと一致するか (空白・大文字小文字は許容)。 */
export function matchesLocalDrillLaunchCommand(submitted: string): boolean {
  return ACCEPTED_LAUNCH_COMMANDS.some((command) => matchesCheckpointCode(command, submitted));
}
