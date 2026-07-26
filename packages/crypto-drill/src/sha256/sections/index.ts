/**
 * SHA-256 ドリル本体 (15 節)。
 *
 * 節の順序は「読める → 計算できる → 実装できる → 誤用しない」の一方向で、前の節の
 * 成果物を次の節が入力に取る。途中の節を飛ばしても画面は開けるが、実装課題は前節の
 * 関数を前提にしているため、順に進むのが最短である。
 */

import { loc } from "../../drill/authoring";
import type { Drill, DrillSection } from "../../drill/types";
import { rotateShiftSection, scheduleSection, smallSigmaSection } from "./bitops";
import { paddingSection, stringToBytesSection, wordsSection } from "./bytes";
import { avalancheSection, hashConceptSection, passwordStorageSection } from "./concepts";
import { bigSigmaSection, chSection, majSection } from "./logic";
import { allRoundsSection, digestSection, singleRoundSection } from "./rounds";

/** 15 節を宣言順どおりに並べたもの。`order` と配列の添字は 1 対 1 に対応する。 */
export const SHA256_SECTIONS: readonly DrillSection[] = [
  stringToBytesSection,
  paddingSection,
  wordsSection,
  rotateShiftSection,
  smallSigmaSection,
  scheduleSection,
  chSection,
  majSection,
  bigSigmaSection,
  singleRoundSection,
  allRoundsSection,
  digestSection,
  avalancheSection,
  hashConceptSection,
  passwordStorageSection,
];

/** SHA-256 ドリル。`id` は進捗の保存キーにも使うので変更は互換性を壊す。 */
export const SHA256_DRILL: Drill = {
  id: "sha256",
  title: loc("SHA-256 をステップ実行で理解する", "Understand SHA-256 step by step"),
  summary: loc(
    "文字列を byte にするところから、64 ラウンドの圧縮、最終ハッシュ、そしてパスワード保存に使ってはいけない理由まで、15 節で SHA-256 を自力実装できる状態まで進む。各節に自動採点と段階ヒントが付く。",
    "Fifteen sections take you from encoding text as bytes, through the 64 compression rounds and the final digest, to why this must not be your password storage — ending with a SHA-256 you wrote yourself. Every section is auto-graded and offers staged hints.",
  ),
  sections: SHA256_SECTIONS,
};
