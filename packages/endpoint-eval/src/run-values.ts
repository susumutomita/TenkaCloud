import { createHash } from "node:crypto";

/**
 * Issue #1973: run ごとに probe の入力値を変えるための決定的な値生成。
 *
 * 「各ステージのテスト入力は run ごとに変え、 固定レスポンスのハードコードだけでは
 * 通りにくくする」を満たす。 run の `seed` (= 作成時に発行するランダム値) と label から
 * SHA-256 で決定的に導出するので、 同じ run の再評価では同じ値になり (= 冪等)、
 * 別 run では別の値になる。
 */
export function seededValue(seed: string, label: string, length = 12): string {
  const hex = createHash("sha256").update(`${seed}:${label}`).digest("hex");
  return hex.slice(0, Math.max(1, length));
}
