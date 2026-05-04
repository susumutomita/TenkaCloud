import { randomBytes } from "node:crypto";

/**
 * チーム単位のログインキーを生成する。32 byte の crypto-strong random を base64url 化。
 * UI には 1 度だけ表示し、その後は DDB に保存される (deploy 中にだけ有効、TTL で自動失効)。
 */
export function generateTeamLoginKey(): string {
  return randomBytes(32).toString("base64url");
}
