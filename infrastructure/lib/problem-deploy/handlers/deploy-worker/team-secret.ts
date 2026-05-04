import { randomBytes } from "node:crypto";

/**
 * 問題 CFn の `DbPassword` パラメータに渡すランダム値を生成する。
 *
 * 18 byte (= 144 bits) の crypto-strong random を base64url で 24 文字に符号化する。
 * 出力アルファベットは `A-Za-z0-9-_` で、CFn 側 `DbPassword` の AllowedPattern
 * (`^[A-Za-z0-9!@#$%^&*()_+\-=]+$`) のサブセットになる。
 *
 * 旧実装は 62 文字アルファベットに `byte % 62` で写していたが、256 が 62 で割り切れない
 * ため modulo bias で前半 8 文字の出現確率が約 1.6% 高くなっていた (CodeQL
 * `js/biased-cryptographic-random` 指摘)。base64url は 6 bit ずつ取り出すので
 * 完全一様。
 */
export function generateProblemSecret(): string {
  return randomBytes(18).toString("base64url");
}
