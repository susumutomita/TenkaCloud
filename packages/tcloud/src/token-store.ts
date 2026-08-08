import { spawnSync } from "node:child_process";

/**
 * Issue #2951: access token の cache。
 *
 * ## なぜ cache するのか
 *
 * M2M の課金は「有効な client_credentials client の数」と「token request の数」で決まる。CLI が
 * 呼ばれるたびに `/oauth2/token` を叩くと、request 数がそのまま実行回数になる。access token の
 * TTL は 15 分なので、その間は取り直さないだけで request 数が桁で減る。実効コストを決めるのは
 * ここである。
 *
 * ## なぜ平文ファイルに書かないのか
 *
 * cache するのは **access token だけ** で、client secret は一切保存しない。token は 15 分で
 * 失効するが secret は失効しないので、両者を同じ場所に置くのは危険度が違う。保存先は OS の
 * keychain (macOS の `security`、Linux の `secret-tool`) を使い、どちらも無い環境では
 * **cache しない**。「keychain が無いから平文ファイルに落とす」は、この issue が禁じている
 * ことそのものなので選ばない。cache が効かない環境ではその旨を告げて毎回取得する。
 */

export interface CachedToken {
  readonly accessToken: string;
  /** epoch ms。ここを過ぎたら期限切れとして扱う。 */
  readonly expiresAtMs: number;
}

export interface TokenStore {
  /** 有効期限内の token を返す。無い / 期限切れなら undefined。 */
  read(key: string, nowMs: number): CachedToken | undefined;
  write(key: string, token: CachedToken): void;
  clear(key: string): void;
  /** cache が実際に永続化されるか。false の場合 CLI は毎回 token を取得する。 */
  readonly persistent: boolean;
  /** 利用者に見せる保存先の説明。 */
  readonly description: string;
}

/** 期限まわりの判定はここ 1 箇所に集約する (= store 実装ごとにぶれさせない)。 */
export function isUsable(token: CachedToken | undefined, nowMs: number): boolean {
  return token !== undefined && token.expiresAtMs > nowMs;
}

/**
 * 期限に安全マージンを引く。ネットワーク往復の途中で切れると 401 になるので、実際の
 * `expires_in` より早めに切る。
 */
export const EXPIRY_SAFETY_MARGIN_MS = 30_000;

export function expiryFromExpiresIn(nowMs: number, expiresInSeconds: number): number {
  return nowMs + Math.max(0, expiresInSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS);
}

/** process 内だけの cache。keychain が無い環境の fallback。 */
export class MemoryTokenStore implements TokenStore {
  readonly persistent = false;
  readonly description = "memory only (no OS keychain found; a token is fetched per invocation)";
  private readonly entries = new Map<string, CachedToken>();

  read(key: string, nowMs: number): CachedToken | undefined {
    const token = this.entries.get(key);
    return isUsable(token, nowMs) ? token : undefined;
  }

  write(key: string, token: CachedToken): void {
    this.entries.set(key, token);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => {
  status: number | null;
  stdout: string;
};

export const defaultCommandRunner: CommandRunner = (command, args, input) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout ?? "" };
};

const SERVICE_NAME = "tenkacloud-tcloud";

/** macOS の `security` keychain。 */
export class MacKeychainTokenStore implements TokenStore {
  readonly persistent = true;
  readonly description = "macOS keychain (security(1))";

  constructor(private readonly run: CommandRunner = defaultCommandRunner) {}

  read(key: string, nowMs: number): CachedToken | undefined {
    const result = this.run("security", [
      "find-generic-password",
      "-s",
      SERVICE_NAME,
      "-a",
      key,
      "-w",
    ]);
    if (result.status !== 0) return undefined;
    return usableFromJson(result.stdout, nowMs);
  }

  write(key: string, token: CachedToken): void {
    // `-U` で既存 entry を更新する。失敗しても CLI の本題は続行できる (= cache が効かないだけ)。
    this.run("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE_NAME,
      "-a",
      key,
      "-w",
      JSON.stringify(token),
    ]);
  }

  clear(key: string): void {
    this.run("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", key]);
  }
}

/** Linux の libsecret (`secret-tool`)。 */
export class SecretToolTokenStore implements TokenStore {
  readonly persistent = true;
  readonly description = "libsecret keyring (secret-tool)";

  constructor(private readonly run: CommandRunner = defaultCommandRunner) {}

  read(key: string, nowMs: number): CachedToken | undefined {
    const result = this.run("secret-tool", ["lookup", "service", SERVICE_NAME, "account", key]);
    if (result.status !== 0) return undefined;
    return usableFromJson(result.stdout, nowMs);
  }

  write(key: string, token: CachedToken): void {
    this.run(
      "secret-tool",
      ["store", "--label", `${SERVICE_NAME} ${key}`, "service", SERVICE_NAME, "account", key],
      JSON.stringify(token),
    );
  }

  clear(key: string): void {
    this.run("secret-tool", ["clear", "service", SERVICE_NAME, "account", key]);
  }
}

function usableFromJson(raw: string, nowMs: number): CachedToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // keychain の中身が壊れているのは「cache 無し」と同義に扱う (= 次で取り直す)。
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as { accessToken?: unknown; expiresAtMs?: unknown };
  if (typeof candidate.accessToken !== "string" || typeof candidate.expiresAtMs !== "number") {
    return undefined;
  }
  const token: CachedToken = {
    accessToken: candidate.accessToken,
    expiresAtMs: candidate.expiresAtMs,
  };
  return isUsable(token, nowMs) ? token : undefined;
}

export interface StoreSelectionEnv {
  readonly platform: string;
  readonly hasCommand: (command: string) => boolean;
}

/** 実行環境に合う store を選ぶ。keychain が無ければ memory (= 永続化しない)。 */
export function selectTokenStore(
  env: StoreSelectionEnv,
  run: CommandRunner = defaultCommandRunner,
): TokenStore {
  if (env.platform === "darwin" && env.hasCommand("security"))
    return new MacKeychainTokenStore(run);
  if (env.hasCommand("secret-tool")) return new SecretToolTokenStore(run);
  return new MemoryTokenStore();
}
