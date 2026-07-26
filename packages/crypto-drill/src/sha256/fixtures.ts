/**
 * 節が参照する題材と、その参照実装 trace。
 *
 * 期待値・図解・真理値表はすべてここから生成する。教材側に定数を手書きしないので、
 * 「解説の図と採点の期待値がずれる」種類の事故が起きない。
 *
 * 題材の選び方:
 *   - `abc`: sha256algorithm.com と同じ既定入力。3 byte なので 1 block に収まる。
 *   - `abd`: `abc` と 1 bit だけ違う (Avalanche Effect の観察用)。
 *   - 55 / 56 byte: パディングで block 数が変わる境界のちょうど両側。
 *   - 64 byte: 完全に 2 block になる (block 間で状態が繋がることの確認用)。
 *   - `天下クラウド`: 文字数 6 / byte 数 18 で、文字と byte の違いが表に出る。
 */

import { traceSha256 } from "./trace";

/** 主題材。1 block・短い・既知テストベクタ。 */
export const PRIMARY_INPUT = "abc";

/** Avalanche Effect 用に 1 bit だけ違う入力。 */
export const AVALANCHE_INPUT = "abd";

/** 1 block に収まる最後の長さ。 */
export const BOUNDARY_55_INPUT = "a".repeat(55);

/** 2 block へ溢れる最初の長さ。 */
export const BOUNDARY_56_INPUT = "a".repeat(56);

/** ちょうど 1 block 分の本文 (パディングで 2 block になる)。 */
export const TWO_BLOCK_INPUT = "a".repeat(64);

/** 文字数と byte 数が食い違う入力。 */
export const UTF8_INPUT = "天下クラウド";

/** 空入力。パディングだけで 1 block になる。 */
export const EMPTY_INPUT = "";

/** 空白を含む一般的な入力。 */
export const HELLO_INPUT = "hello world";

export const PRIMARY_TRACE = traceSha256(PRIMARY_INPUT);
export const AVALANCHE_TRACE = traceSha256(AVALANCHE_INPUT);
export const BOUNDARY_55_TRACE = traceSha256(BOUNDARY_55_INPUT);
export const BOUNDARY_56_TRACE = traceSha256(BOUNDARY_56_INPUT);
export const TWO_BLOCK_TRACE = traceSha256(TWO_BLOCK_INPUT);
export const UTF8_TRACE = traceSha256(UTF8_INPUT);
export const EMPTY_TRACE = traceSha256(EMPTY_INPUT);
export const HELLO_TRACE = traceSha256(HELLO_INPUT);

/** 主題材の 1 つ目の block (`abc` は 1 block なのでこれで全部)。 */
export const PRIMARY_BLOCK = PRIMARY_TRACE.blocks[0];
