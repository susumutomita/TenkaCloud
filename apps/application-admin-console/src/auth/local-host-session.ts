import type { TokenSet } from "@tenkacloud/auth-client";

/**
 * ローカル大会の主催者 session を、reload で失わないための tab 内の控え。
 *
 * Cognito 経路は token を memory だけに置き、reload は Hosted UI の cookie で silent re-auth する。
 * ローカル大会にはその cookie に当たるものが無く、reload のたびに主催者キーの再入力が必要だった。
 * 127.0.0.1 の cookie は port をまたいで問題環境の listener にも送られるため使わず、origin (port
 * 込み) と tab に閉じる `sessionStorage` に置く。tab を閉じる・logout・期限切れで消える。
 * 復元した token はサーバーで確かめてから使う (local-reset や失効済みの session を戻さない)。
 */
const STORAGE_KEY = "TenkaCloud.localHost.organizerSession";

function isTokenSet(value: unknown): value is TokenSet {
  if (!value || typeof value !== "object") return false;
  const tokens = value as Record<string, unknown>;
  return (
    typeof tokens.idToken === "string" &&
    typeof tokens.accessToken === "string" &&
    typeof tokens.refreshToken === "string" &&
    typeof tokens.expiresAt === "number"
  );
}

export function saveLocalHostSession(
  tokens: TokenSet,
  storage: Pick<Storage, "setItem"> = sessionStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // 保存できない環境では従来どおり reload で主催者キーを入れ直す。
  }
}

export function clearLocalHostSession(storage: Pick<Storage, "removeItem"> = sessionStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // 読めない storage には復元できる session も無い。
  }
}

/** 期限内の控えだけを返す。壊れた・期限切れの控えは消す。 */
export function loadLocalHostSession(
  now = Date.now(),
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
): TokenSet | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (isTokenSet(parsed) && parsed.expiresAt > now) return parsed;
  clearLocalHostSession(storage);
  return null;
}
