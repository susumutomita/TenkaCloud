import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Issue #988: CLI が Cognito OAuth で取得した tokens を OS-specific credential store に保存する。
 *
 * Phase 1: ~/.config/tenkacloud/credentials (mode 0600) の plain JSON。
 * Phase 2: macOS Keychain / Linux Secret Service / Windows Credential Manager の OS-native
 * library に差し替える (= keytar / @napi-rs/keyring 等を検討)。 本 phase は CLI を spike として
 * 起動させ、 token storage 仕様の安定後に library 切替する design。
 *
 * file mode 0600 (= owner read/write only) で他 user / process からの読み取りを防ぐ。
 */

export interface StoredTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  /** Unix seconds when accessToken expires. */
  readonly expiresAt: number;
  /** Cognito issuer URL (= "https://cognito-idp.<region>.amazonaws.com/<userPoolId>") */
  readonly issuer: string;
  /** UserPool client ID (= OAuth client_id) */
  readonly clientId: string;
}

function credentialsPath(): string {
  return resolve(homedir(), ".config/tenkacloud/credentials");
}

export function saveTokens(tokens: StoredTokens): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadTokens(): StoredTokens | undefined {
  const path = credentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredTokens;
  } catch {
    return undefined;
  }
}

export function clearTokens(): void {
  const path = credentialsPath();
  if (!existsSync(path)) return;
  writeFileSync(path, "", { mode: 0o600 });
}

export function isExpired(
  tokens: StoredTokens,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return tokens.expiresAt <= nowSec;
}
