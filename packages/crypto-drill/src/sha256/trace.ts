/**
 * SHA-256 を「途中を全部覗ける形」で実行する参照実装。
 *
 * ドリルの期待値は **すべてこの trace から機械的に生成する**。人手で書いた期待値表を
 * 持たないため、教材側に誤答が焼き付く余地がない (trace 自体は既知テストベクタと
 * NIST 定数導出で検証する)。
 *
 * 計算量は入力 block 数に比例し、1 block あたり 64 ラウンド分の中間値を保持する。
 * 教材の入力は数 block なので、可視化のために全ラウンドを保持して問題ない。
 */

import { BLOCK_WORDS, INITIAL_HASH, ROUND_CONSTANTS, ROUNDS, STATE_LABELS } from "./constants";
import { bigSigma0, bigSigma1, ch, maj, smallSigma0, smallSigma1 } from "./functions";
import { blockToWords, padMessage, splitBlocks } from "./padding";
import { add32, toHex32, utf8Encode } from "./word";

/** a..h の 8 語からなる圧縮関数の状態。 */
export type Sha256State = readonly number[];

/** W[i] (16 ≤ i < 64) を 1 語作る過程の中間値。 */
export interface ScheduleStep {
  readonly index: number;
  readonly wMinus15: number;
  readonly wMinus2: number;
  readonly sigma0: number;
  readonly sigma1: number;
  readonly wMinus16: number;
  readonly wMinus7: number;
  readonly result: number;
}

/** 圧縮ラウンド 1 回の中間値。 */
export interface RoundTrace {
  readonly index: number;
  readonly before: Sha256State;
  readonly k: number;
  readonly w: number;
  readonly bigSigma1: number;
  readonly ch: number;
  readonly t1: number;
  readonly bigSigma0: number;
  readonly maj: number;
  readonly t2: number;
  readonly after: Sha256State;
}

/** 1 block を処理する過程の中間値。 */
export interface BlockTrace {
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly words: readonly number[];
  readonly scheduleSteps: readonly ScheduleStep[];
  readonly rounds: readonly RoundTrace[];
  readonly hashBefore: Sha256State;
  readonly hashAfter: Sha256State;
}

/** SHA-256 を 1 回通した全過程。 */
export interface Sha256Trace {
  readonly input: string;
  readonly message: Uint8Array;
  readonly messageBitLength: number;
  readonly padded: Uint8Array;
  readonly blocks: readonly BlockTrace[];
  readonly hash: Sha256State;
  readonly digest: string;
}

/**
 * 16 語の block から W[0..63] と 16 番目以降の導出過程を作る。
 *
 * 16 語に足りない入力は呼び出し側のバグなので黙って 0 埋めせず throw する
 * (中間値が静かにずれた教材は、間違った答えを正解として教えてしまう)。
 */
export function expandSchedule(blockWords: readonly number[]): {
  readonly words: readonly number[];
  readonly steps: readonly ScheduleStep[];
} {
  if (blockWords.length !== BLOCK_WORDS) {
    throw new Error(`expandSchedule requires exactly ${BLOCK_WORDS} words`);
  }
  const words = [...blockWords];
  const steps: ScheduleStep[] = [];
  for (let index = BLOCK_WORDS; index < ROUNDS; index += 1) {
    const wMinus15 = words[index - 15];
    const wMinus2 = words[index - 2];
    const wMinus16 = words[index - 16];
    const wMinus7 = words[index - 7];
    const sigma0 = smallSigma0(wMinus15);
    const sigma1 = smallSigma1(wMinus2);
    const result = add32(wMinus16, sigma0, wMinus7, sigma1);
    words.push(result);
    steps.push({ index, wMinus15, wMinus2, sigma0, sigma1, wMinus16, wMinus7, result });
  }
  return { words, steps };
}

/** 圧縮ラウンド 1 回。`before` を受けて次の状態と中間値を返す。 */
export function compressRound(
  before: Sha256State,
  index: number,
  w: number,
  k: number = ROUND_CONSTANTS[index],
): RoundTrace {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = before;
  const s1 = bigSigma1(e);
  const chValue = ch(e, f, g);
  const t1 = add32(h, s1, chValue, k, w);
  const s0 = bigSigma0(a);
  const majValue = maj(a, b, c);
  const t2 = add32(s0, majValue);
  const after: Sha256State = [add32(t1, t2), a, b, c, add32(d, t1), e, f, g];
  return {
    index,
    before,
    k,
    w,
    bigSigma1: s1,
    ch: chValue,
    t1,
    bigSigma0: s0,
    maj: majValue,
    t2,
    after,
  };
}

function traceBlock(index: number, bytes: Uint8Array, hashBefore: Sha256State): BlockTrace {
  const { words, steps } = expandSchedule(blockToWords(bytes));
  const rounds: RoundTrace[] = [];
  let state = hashBefore;
  for (let round = 0; round < ROUNDS; round += 1) {
    const trace = compressRound(state, round, words[round]);
    rounds.push(trace);
    state = trace.after;
  }
  const hashAfter = hashBefore.map((value, i) => add32(value, state[i]));
  return { index, bytes, words, scheduleSteps: steps, rounds, hashBefore, hashAfter };
}

/** ハッシュ状態 (8 語) を 64 桁の 16 進ダイジェストへ連結する。 */
export function stateToDigest(state: Sha256State): string {
  return state.map(toHex32).join("");
}

/** 文字列を UTF-8 として読み、SHA-256 の全過程を返す。 */
export function traceSha256(input: string): Sha256Trace {
  const message = utf8Encode(input);
  const padded = padMessage(message);
  const blocks: BlockTrace[] = [];
  let hash: Sha256State = INITIAL_HASH;
  splitBlocks(padded).forEach((bytes, index) => {
    const block = traceBlock(index, bytes, hash);
    blocks.push(block);
    hash = block.hashAfter;
  });
  return {
    input,
    message,
    messageBitLength: message.length * 8,
    padded,
    blocks,
    hash,
    digest: stateToDigest(hash),
  };
}

/** ダイジェストだけが欲しいときの近道。 */
export function sha256Hex(input: string): string {
  return traceSha256(input).digest;
}

/** `STATE_LABELS` と状態を突き合わせた表示用の組。 */
export function labelState(state: Sha256State): readonly { label: string; word: number }[] {
  return STATE_LABELS.map((label, i) => ({ label, word: state[i] ?? 0 }));
}
