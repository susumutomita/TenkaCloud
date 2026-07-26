/**
 * SHA-256 が扱う唯一の数値型である「32 bit 符号なし語 (word)」の演算。
 *
 * JavaScript のビット演算子は 32 bit **符号付き** 整数を返すため、`>>> 0` で符号なしへ
 * 畳み戻す。この一手間を各所に散らすと `-1962516819` のような負値が学習者向けの
 * 中間値表示に混入するため、word 演算はすべてこの module 経由に閉じる。
 */

/** 32 bit に収まる符号なし整数へ畳み戻す。 */
export function toWord(value: number): number {
  return value >>> 0;
}

/** 右ローテート (ROTR^n)。あふれた下位 n bit が上位へ回り込む。 */
export function rotr32(word: number, shift: number): number {
  const n = shift % 32;
  if (n === 0) return toWord(word);
  return toWord((word >>> n) | (word << (32 - n)));
}

/** 論理右シフト (SHR^n)。あふれた下位 n bit は捨てられ、上位は 0 で埋まる。 */
export function shr32(word: number, shift: number): number {
  if (shift >= 32) return 0;
  return toWord(word >>> shift);
}

/** mod 2^32 の加算。SHA-256 の "+" はすべてこれである。 */
export function add32(...words: readonly number[]): number {
  return toWord(words.reduce((sum, word) => sum + toWord(word), 0));
}

/** 32 bit 語を 8 桁の小文字 16 進へ。 */
export function toHex32(word: number): string {
  return toWord(word).toString(16).padStart(8, "0");
}

/** 32 bit 語を 32 文字の 2 進へ。 */
export function toBinary32(word: number): string {
  return toWord(word).toString(2).padStart(32, "0");
}

/** 1 byte を 2 桁の小文字 16 進へ。 */
export function byteToHex(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, "0");
}

/** 1 byte を 8 文字の 2 進へ。 */
export function byteToBinary(byte: number): string {
  return (byte & 0xff).toString(2).padStart(8, "0");
}

/** byte 列を連結した 16 進文字列へ。 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byteToHex).join("");
}

/** byte 列を連結した 2 進文字列へ (byte 境界の区切りは入れない)。 */
export function bytesToBinary(bytes: Uint8Array): string {
  return Array.from(bytes, byteToBinary).join("");
}

/**
 * byte 列の先頭 4 byte をビッグエンディアンで 1 語に読む。
 *
 * ビッグエンディアン = 最上位 byte が先頭。SHA-256 は語の読み出しも長さの追記も
 * すべてビッグエンディアンで、ここを取り違えると以降の全中間値がずれる。
 */
export function readWordBE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return toWord((b0 << 24) | (b1 << 16) | (b2 << 8) | b3);
}

/** 語をビッグエンディアン 4 byte として書き出す。 */
export function writeWordBE(target: Uint8Array, offset: number, word: number): void {
  const value = toWord(word);
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** 文字列を UTF-8 byte 列へ。SHA-256 の入力は文字ではなく byte 列である。 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
