/**
 * SHA-256 のパディング (FIPS 180-4 §5.1.1)。
 *
 * 目的は 2 つある。
 *   1. 入力長を 512 bit の倍数へ揃える (圧縮関数は block 単位でしか動けない)。
 *   2. **元の bit 長を末尾に刻む** ことで、`"a"` と `"a\x80"` のように
 *      パディングを剥がすと同一に見える入力を区別する (長さ強化 / Merkle-Damgård)。
 *
 * 手順は「1 bit の 1 を足す → 0 で埋める → 64 bit のビッグエンディアン長を足す」。
 * 0 埋めの量は最小の非負整数なので、余白が 8 byte 未満なら block が 1 つ増える。
 * 55 byte が 1 block で収まる最後の長さ、56 byte で 2 block になるのはこれが理由である。
 */

import { BLOCK_BYTES, LENGTH_BYTES } from "./constants";
import { readWordBE } from "./word";

/** パディング後の総 byte 数。 */
export function paddedLength(messageBytes: number): number {
  const withMarker = messageBytes + 1 + LENGTH_BYTES;
  return Math.ceil(withMarker / BLOCK_BYTES) * BLOCK_BYTES;
}

/** 挿入される 0 byte の個数 (`0x80` と長さフィールドを除いた純粋な 0 埋め)。 */
export function zeroPaddingLength(messageBytes: number): number {
  return paddedLength(messageBytes) - messageBytes - 1 - LENGTH_BYTES;
}

/**
 * メッセージへパディングを施した byte 列を返す。
 *
 * 長さフィールドは **bit 長** であり byte 長ではない。`Number` では 2^53 bit を超える
 * 入力を表現できないため `BigInt` で 64 bit へ書き込む (ドリルの入力規模では
 * 上位 32 bit は常に 0 だが、仕様どおり 64 bit 分を書く)。
 */
export function padMessage(message: Uint8Array): Uint8Array {
  const total = paddedLength(message.length);
  const padded = new Uint8Array(total);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  const bitLength = BigInt(message.length) * 8n;
  for (let i = 0; i < LENGTH_BYTES; i += 1) {
    const shift = BigInt((LENGTH_BYTES - 1 - i) * 8);
    padded[total - LENGTH_BYTES + i] = Number((bitLength >> shift) & 0xffn);
  }
  return padded;
}

/** パディング済み byte 列を 64 byte block へ切り分ける。 */
export function splitBlocks(padded: Uint8Array): readonly Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    blocks.push(padded.slice(offset, offset + BLOCK_BYTES));
  }
  return blocks;
}

/** 64 byte block を 16 個の 32 bit 語へ (ビッグエンディアン)。 */
export function blockToWords(block: Uint8Array): readonly number[] {
  const words: number[] = [];
  for (let i = 0; i < BLOCK_BYTES; i += 4) {
    words.push(readWordBE(block, i));
  }
  return words;
}
