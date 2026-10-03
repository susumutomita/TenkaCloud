/**
 * DDB pagination cursor の安全な encode / decode (Issue #862)。
 *
 * cursor は DDB の `ExclusiveStartKey` にそのまま渡るので、 attacker が任意 shape の JSON
 * を送ると pagination 経路を破壊したり推測攻撃に使える。 base64url + JSON だけでは shape を
 * 保証できないため、 「キーが caller の allowlist 内」「各 value が長さ 1–256 の string」に
 * 絞って shape を pin する。 不一致なら `undefined` を返し、 page を最初からやり直す
 * (= silent reset の方が attacker に情報を与えない)。
 *
 * `createCursorCodec` で allowlist を渡し、 各 list handler が自分の有効キー集合
 * (Deployments の GSI1/GSI2 系、 Events の PK/SK 系など) を注入する。
 */

const MAX_CURSOR_LENGTH = 512;
const MAX_VALUE_LENGTH = 256;

export interface CursorCodec {
  /** DDB の `LastEvaluatedKey` を base64url cursor 文字列に encode する。 */
  encode(key: Record<string, unknown>): string;
  /**
   * cursor を decode し、 allowlist と value 制約を満たす Key だけを返す。
   * 不正 (oversized / 不正 base64 / 不正 JSON / allowlist 外キー / 非 string value) なら
   * `undefined`。
   */
  decode(cursor: string): Record<string, unknown> | undefined;
}

/**
 * 指定した allowlist で cursor の encode / decode を行う codec を生成する。
 *
 * @param allowedKeys この list が `ExclusiveStartKey` に許可するキー集合
 *   (例: Deployments なら PK/SK/GSI1PK/GSI1SK/..., Events なら PK/SK)。
 */
export function createCursorCodec(allowedKeys: ReadonlySet<string>): CursorCodec {
  return {
    encode: encodeCursor,
    decode: (cursor) => decodeCursor(cursor, allowedKeys),
  };
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // 不正な base64 / JSON は undefined として最初から開始
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const key = parsed as Record<string, unknown>;
  // 各 key が allowlist 内、 各 value が長さ 1–256 の string であることを pin。 数値 /
  // boolean / ネスト object は弾く (= DDB Key は string-only の運用想定)。
  for (const [k, v] of Object.entries(key)) {
    if (!allowedKeys.has(k) || !isValidKeyValue(v)) return undefined;
  }
  return key;
}

function isValidKeyValue(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_VALUE_LENGTH;
}
