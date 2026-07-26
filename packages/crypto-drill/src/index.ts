/**
 * `@tenkacloud/crypto-drill`: 暗号分野の段階学習ドリル。
 *
 * 2 層に分かれている。
 *   - `drill/`: アルゴリズムに依存しない教材フォーマット (型 / 採点 / 進捗 / AI サポート)。
 *   - `sha256/`: SHA-256 の参照実装 (全中間値を保持する trace) と 15 節の本文。
 *
 * SPA からは この 1 ファイル経由で import する。UI は「trace が返す中間値を描く」だけで、
 * 期待値や図解の値を自分で計算しない。
 */

export { answerCase, choice, hint, loc } from "./drill/authoring";
export {
  buildCoachPrompt,
  type CoachMode,
  type CoachPromptInput,
  hasMoreHints,
  visibleHints,
} from "./drill/coach";
export {
  type CaseResult,
  type CaseVerdict,
  type ChoiceSubmission,
  type GradeResult,
  gradeCase,
  gradeChoiceTask,
  gradeTask,
  gradeValueTask,
  type NormalizedAnswer,
  normalizeAnswer,
  type TaskSubmission,
  type ValueSubmission,
} from "./drill/grade";
export {
  completedSectionCount,
  type DrillProgress,
  emptyProgress,
  firstIncompleteSection,
  isSectionComplete,
  parseProgress,
  recordAttempt,
  renderProgressBar,
  revealNextHint,
  serializeProgress,
  type TaskProgress,
  taskProgress,
} from "./drill/progress";
export {
  type AnswerFormat,
  type BitLane,
  type ChoiceTask,
  type DiffRow,
  type Drill,
  type DrillCase,
  type DrillChoice,
  type DrillHint,
  type DrillSection,
  type DrillTask,
  type DrillVisual,
  isValueTask,
  type LocaleCode,
  type Localized,
  listTasks,
  localize,
  type RoundRow,
  type TruthRow,
  type ValueTask,
  type WordRow,
} from "./drill/types";
export { type DigestDiff, digestDiff, nibbleDiffFlags } from "./sha256/avalanche";
export {
  BLOCK_BYTES,
  BLOCK_WORDS,
  INITIAL_HASH,
  LENGTH_BYTES,
  ROUND_CONSTANTS,
  ROUNDS,
  STATE_LABELS,
} from "./sha256/constants";
export {
  bigSigma0,
  bigSigma1,
  ch,
  maj,
  smallSigma0,
  smallSigma1,
} from "./sha256/functions";
export {
  blockToWords,
  paddedLength,
  padMessage,
  splitBlocks,
  zeroPaddingLength,
} from "./sha256/padding";
export { SHA256_DRILL, SHA256_SECTIONS } from "./sha256/sections";
export {
  type BlockTrace,
  compressRound,
  expandSchedule,
  labelState,
  type RoundTrace,
  type ScheduleStep,
  type Sha256State,
  type Sha256Trace,
  sha256Hex,
  stateToDigest,
  traceSha256,
} from "./sha256/trace";
export {
  add32,
  bytesToBinary,
  bytesToHex,
  byteToBinary,
  byteToHex,
  readWordBE,
  rotr32,
  shr32,
  toBinary32,
  toHex32,
  toWord,
  utf8Encode,
  writeWordBE,
} from "./sha256/word";
