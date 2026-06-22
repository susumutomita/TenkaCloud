import type { ChallengeDefinition } from "../challenge.js";
import { cloudflareApiSecurity001 } from "./cloudflare-api-security-001.js";

/**
 * Issue #1973: 登録済みチャレンジ (= 隠しテスト) のカタログ。 新問題はここに 1 行足すだけ
 * (= engine は無変更)。 参加者リポジトリには出さない server-side カタログ。
 */
export const CHALLENGES: Readonly<Record<string, ChallengeDefinition>> = {
  [cloudflareApiSecurity001.id]: cloudflareApiSecurity001,
};

export { cloudflareApiSecurity001 };
