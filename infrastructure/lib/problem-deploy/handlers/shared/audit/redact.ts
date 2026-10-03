/**
 * Issue #1292: audit log の `before` / `after` snapshot を redact する allowlist-based
 * helper。 raw secret / PII が DDB AuditEvents table に書き込まれないように、 caller が
 * 明示的に渡した resource type の allowlist field のみを保存する。
 *
 * 設計方針:
 * - **allowlist only** (= blocklist にしない): 「忘れた field は出さない」 が安全側のデフォルト。
 *   resource type を未登録なら空 object を返す (= fail-closed)。
 * - **shallow only**: 1 階層のみ allowlist 対象。 nested object (= 例 `event.metadata`)
 *   は string にして渡すか、 別 resource type を切る。 PII 漏れ防止と redact cost の
 *   trade-off で shallow に倒す。
 * - **value coerce**: allowlist 該当 field でも値が `string | number | boolean | null` 以外
 *   (= object / function / undefined / Date instance 等) なら drop する (= shape 想定外で
 *   raw 構造が漏れるのを防ぐ)。
 * - **default redact value**: 値が allowlist の `"[REDACTED]"` field なら caller が
 *   `String` 化済の placeholder を入れて呼ぶ前提 (= 本 helper は値内容を改変しない)。
 *
 * 各 handler は writeAuditEvent 呼び出し前に `redactForAudit("event", { id, name, scoringLocked })`
 * を呼んで `before` / `after` field の安全 snapshot を作る。
 */

export type AuditResourceType =
  | "event"
  | "competitor_account"
  | "tenant_saml_config"
  | "deployment"
  | "team"
  | "external_id"
  | "user"
  | "tenant";

/**
 * resource type 毎に audit に保存して良い field の allowlist。
 *
 * 追加方針: 新しい mutating route から audit を取る場合、 該当する resource type を
 * 探して field を追加する。 secret / PII 系 (= password / accessKey / saml metadata 内
 * の x509 cert / email 等) は **入れない**。 email を載せる場合は `actorUsername` 経由で
 * 1 階層上で扱う (= audit-log.ts 参照)。
 */
const REDACT_ALLOWLIST: Readonly<Record<AuditResourceType, ReadonlySet<string>>> = {
  event: new Set([
    "id",
    "eventId",
    "name",
    "internalSlug",
    "status",
    "scoringLocked",
    "startsAt",
    "endsAt",
    "scoreboardFreezeMinutes",
    "archivedAt",
  ]),
  competitor_account: new Set(["awsAccountId", "alias", "verified", "verifiedAt", "tenantId"]),
  tenant_saml_config: new Set([
    // 設定値ではなく 「設定の有無 / どの IdP に向いているか」 だけを残す。
    // metadata XML / x509 / signing key は **絶対に** 入れない。
    "providerName",
    "ssoUrl",
    "enabled",
  ]),
  deployment: new Set([
    "jobId",
    "tenantId",
    "teamId",
    "problemId",
    "eventId",
    "status",
    "createdAt",
  ]),
  team: new Set(["teamId", "name", "tenantId"]),
  external_id: new Set([
    // ExternalId 自体は SecureString 経路でのみ扱う。 audit では 「存在した / 回転した」 だけ。
    "awsAccountId",
    "rotatedAt",
  ]),
  user: new Set([
    // email は actorUsername 経由で 1 階層上で扱うので、 ここには入れない。
    "username",
    "role",
    "status",
  ]),
  tenant: new Set(["tenantId", "tier", "status", "isolation"]),
};

export type RedactedValue = string | number | boolean | null;
export type RedactedSnapshot = Readonly<Record<string, RedactedValue>>;

function isPrimitive(value: unknown): value is RedactedValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * resource type の allowlist に含まれる field のみを抽出し、 値が primitive
 * (= string / number / boolean / null) のものだけを返す。
 *
 * `source` が `undefined` / `null` / object 以外なら空 object を返す (= fail-closed)。
 *
 * unit test pin (`redact.test.ts`):
 * - allowlist 外 field を drop する
 * - non-primitive 値 (= nested object / Date / function) を drop する
 * - 未登録 resource type で空 object を返す
 * - null / undefined / array 等の異常 source で空 object を返す
 */
export function redactForAudit(resource: AuditResourceType, source: unknown): RedactedSnapshot {
  if (source === null || source === undefined || typeof source !== "object") return {};
  if (Array.isArray(source)) return {};
  const allowlist = REDACT_ALLOWLIST[resource];
  if (!allowlist) return {};
  const out: Record<string, RedactedValue> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (!allowlist.has(key)) continue;
    if (!isPrimitive(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `before` / `after` snapshot から 「変わった field」 だけを抜き出す helper。
 * audit row の DDB 書き込みサイズを抑え、 review 側の認知コストも下げる。
 *
 * 同値判定は primitive 同士の `===` のみ。 nested object は redactForAudit で既に
 * 排除されているので、 string/number/boolean/null の比較で十分。
 */
export function diffSnapshots(
  before: RedactedSnapshot,
  after: RedactedSnapshot,
): { readonly before: RedactedSnapshot; readonly after: RedactedSnapshot } {
  const beforeOut: Record<string, RedactedValue> = {};
  const afterOut: Record<string, RedactedValue> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b === a) continue;
    if (b !== undefined) beforeOut[k] = b;
    if (a !== undefined) afterOut[k] = a;
  }
  return { before: beforeOut, after: afterOut };
}
