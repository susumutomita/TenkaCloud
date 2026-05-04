import { randomBytes } from "node:crypto";

/**
 * 問題 CFn の `DbPassword` パラメータに渡すランダム値を生成する (mysql 仕様の制約に
 * 合わせて記号は使わず、英数字のみで 24 文字)。worker は deploy 起動の都度 1 回だけ
 * 生成し、CFn のパラメータと DDB の `dbPassword` フィールドに同じ値を保存する。
 */
export function generateProblemSecret(): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
