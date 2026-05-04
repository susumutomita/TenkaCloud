import { randomBytes } from "node:crypto";

/**
 * 問題 CFn の `DbPassword` パラメータに渡す 144 bit のランダム値。
 * base64url の 24 文字 (alphabet `A-Za-z0-9-_`) を返す。CFn の AllowedPattern
 * (`^[A-Za-z0-9!@#$%^&*()_+\-=]+$`) のサブセットになるよう base64url を選ぶ。
 *
 * `byte % alphabet.length` 方式は modulo bias が乗るため使わない。base64url は
 * 6 bit ずつ取り出すので完全一様。
 */
export function generateProblemSecret(): string {
  return randomBytes(18).toString("base64url");
}
