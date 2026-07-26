/**
 * SHA-256 の定数表 (FIPS 180-4 §4.2.2 / §5.3.3)。
 *
 * 値は「素数の平方根 / 立方根の小数部の先頭 32 bit」から決まる nothing-up-my-sleeve 定数で、
 * 設計者が任意に選んだ魔法の数ではない。`constants.test.ts` が実際に平方根・立方根から
 * 導出して一致を検査するため、この表に typo が入れば必ず落ちる。
 */

/** ラウンド定数 K[0..63] = 先頭 64 素数の立方根の小数部 先頭 32 bit。 */
export const ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** 初期ハッシュ値 H[0..7] = 先頭 8 素数の平方根の小数部 先頭 32 bit。 */
export const INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** 1 block = 512 bit = 64 byte。 */
export const BLOCK_BYTES = 64;

/** 1 block = 16 語。message schedule はこれを 64 語へ伸ばす。 */
export const BLOCK_WORDS = 16;

/** 圧縮関数のラウンド数。 */
export const ROUNDS = 64;

/** 末尾に付くメッセージ長フィールドの幅 (64 bit = 8 byte)。 */
export const LENGTH_BYTES = 8;

/** 状態変数 a..h の名前 (表示順)。 */
export const STATE_LABELS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
