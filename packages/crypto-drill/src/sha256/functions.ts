/**
 * SHA-256 の 6 つのビット関数 (FIPS 180-4 §4.1.2)。
 *
 * 小文字 σ (sigma) は **message schedule** 用、大文字 Σ (bigSigma) は **圧縮ラウンド** 用。
 * σ が ROTR 2 回 + SHR 1 回、Σ が ROTR 3 回という差が、両者を混同したときの
 * 典型的なバグ (= 最終ハッシュだけ合わない) の原因になる。
 */

import { rotr32, shr32, toWord } from "./word";

/** Ch(x, y, z) — x の bit が 1 なら y、0 なら z を選ぶ (choose)。 */
export function ch(x: number, y: number, z: number): number {
  return toWord((x & y) ^ (~x & z));
}

/** Maj(x, y, z) — bit ごとの多数決 (majority)。 */
export function maj(x: number, y: number, z: number): number {
  return toWord((x & y) ^ (x & z) ^ (y & z));
}

/** σ0(x) = ROTR^7 ⊕ ROTR^18 ⊕ SHR^3 — message schedule 用。 */
export function smallSigma0(x: number): number {
  return toWord(rotr32(x, 7) ^ rotr32(x, 18) ^ shr32(x, 3));
}

/** σ1(x) = ROTR^17 ⊕ ROTR^19 ⊕ SHR^10 — message schedule 用。 */
export function smallSigma1(x: number): number {
  return toWord(rotr32(x, 17) ^ rotr32(x, 19) ^ shr32(x, 10));
}

/** Σ0(x) = ROTR^2 ⊕ ROTR^13 ⊕ ROTR^22 — 圧縮ラウンドの T2 側。 */
export function bigSigma0(x: number): number {
  return toWord(rotr32(x, 2) ^ rotr32(x, 13) ^ rotr32(x, 22));
}

/** Σ1(x) = ROTR^6 ⊕ ROTR^11 ⊕ ROTR^25 — 圧縮ラウンドの T1 側。 */
export function bigSigma1(x: number): number {
  return toWord(rotr32(x, 6) ^ rotr32(x, 11) ^ rotr32(x, 25));
}
