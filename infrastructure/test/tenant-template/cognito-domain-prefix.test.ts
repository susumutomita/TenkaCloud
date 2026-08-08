import { describe, expect, it } from "vitest";
import { buildCognitoDomainPrefix } from "../../lib/tenant-template/identity-provider";

const COGNITO_LIMIT = 63;
const ACCOUNT_ID = "672726205532";

/**
 * Cognito の `domain` は 63 字上限で、 超えると `CreateUserPoolDomain` が
 * `InvalidParameterException` を返す。 CloudFormation はこれを
 * `Invalid request provided: AWS::Cognito::UserPoolDomain` という汎用文言に丸めるため、
 * 原因が読み取れない。 2026-08-08 の siloverify がこれで ROLLBACK した。
 */
describe("buildCognitoDomainPrefix", () => {
  it("should keep the pooled prefix byte-identical (changing it REPLACEs the live domain)", () => {
    // これは cosmetic な pin ではない。 pooled の UserPoolDomain は稼働中で、 prefix が変わると
    // AWS::Cognito::UserPoolDomain が REPLACE され、 pooled tenant の Hosted UI ログイン URL が
    // 変わってしまう。 silo を直すために format を触るとき、 pooled を巻き込まないための番人。
    expect(buildCognitoDomainPrefix("development", "pooled", ACCOUNT_ID)).toBe(
      "tenkacloud-development-pooled-672726205532",
    );
  });

  it("should fit a UUID tenantId inside the Cognito limit", () => {
    // SBT が発行するのは UUID (36 字)。 素朴に連結すると 72 字で上限を超える。
    const uuid = "e6d84953-426b-481c-9c89-bb1027fc54a4";
    const prefix = buildCognitoDomainPrefix("development", uuid, ACCOUNT_ID);

    expect(`tenkacloud-development-${uuid}-${ACCOUNT_ID}`.length).toBe(72);
    expect(prefix.length).toBeLessThanOrEqual(COGNITO_LIMIT);
  });

  it("should stay within the limit for the longest realistic inputs", () => {
    const uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    for (const env of ["development", "staging", "production"]) {
      expect(buildCognitoDomainPrefix(env, uuid, ACCOUNT_ID).length).toBeLessThanOrEqual(
        COGNITO_LIMIT,
      );
    }
  });

  it("should be deterministic so redeploying a tenant does not REPLACE its domain", () => {
    const uuid = "e6d84953-426b-481c-9c89-bb1027fc54a4";
    expect(buildCognitoDomainPrefix("development", uuid, ACCOUNT_ID)).toBe(
      buildCognitoDomainPrefix("development", uuid, ACCOUNT_ID),
    );
  });

  it("should derive distinct prefixes for distinct tenants", () => {
    const a = buildCognitoDomainPrefix(
      "development",
      "e6d84953-426b-481c-9c89-bb1027fc54a4",
      ACCOUNT_ID,
    );
    const b = buildCognitoDomainPrefix(
      "development",
      "2e5cfa42-bb54-40ac-8bea-78f4390727ec",
      ACCOUNT_ID,
    );
    expect(a).not.toBe(b);
  });

  it("should shorten by dropping separators and abbreviating the environment", () => {
    // 縮めるのは環境名と区切り文字だけで、 tenantId 自体は 1 文字も落とさない。 domain から
    // どの tenant のものか読み取れることと、 縮約による衝突余地を作らないことが要件。
    const uuid = "e6d84953-426b-481c-9c89-bb1027fc54a4";
    expect(buildCognitoDomainPrefix("development", uuid, ACCOUNT_ID)).toBe(
      `tenkacloud-dev-e6d84953426b481c9c89bb1027fc54a4-${ACCOUNT_ID}`,
    );
  });

  it("should keep the full tenantId so two tenants can never share a domain", () => {
    // hash 縮約をやめた核心。 UUID の全 bit が残るので、 別 tenant が同じ prefix になる経路が
    // 原理的に存在しない (hash 先頭 12 字なら 48bit まで縮んでいた)。
    const uuid = "e6d84953-426b-481c-9c89-bb1027fc54a4";
    expect(buildCognitoDomainPrefix("development", uuid, ACCOUNT_ID)).toContain(
      uuid.replaceAll("-", ""),
    );
  });

  it("should give each environment a distinct abbreviation", () => {
    const uuid = "e6d84953-426b-481c-9c89-bb1027fc54a4";
    const prefixes = ["development", "staging", "production"].map((env) =>
      buildCognitoDomainPrefix(env, uuid, ACCOUNT_ID),
    );
    expect(new Set(prefixes).size).toBe(3);
  });

  it("should truncate from the tail if a tenantId ever exceeds the remaining budget", () => {
    // UUID / ULID では到達しない保険経路。 到達したときに (a) 上限を守り、 (b) 乱数部が末尾に
    // ある ID の性質どおり後ろを残すことを固定する。
    const longTid = `${"a".repeat(40)}0123456789abcdef`;
    const prefix = buildCognitoDomainPrefix("development", longTid, ACCOUNT_ID);

    expect(prefix.length).toBe(COGNITO_LIMIT);
    expect(prefix).toContain("0123456789abcdef");
  });

  it("should only use lowercase letters, digits and hyphens", () => {
    const prefix = buildCognitoDomainPrefix(
      "Development",
      "E6D84953-426B-481C-9C89-BB1027FC54A4",
      ACCOUNT_ID,
    );
    expect(prefix).toMatch(/^[a-z0-9-]+$/);
  });

  it("should still synthesize when env or account are unresolved", () => {
    expect(buildCognitoDomainPrefix("", "pooled", "")).toBe(
      "tenkacloud-synth-pooled-synthplaceholder",
    );
  });
});
