import { describe, expect, it } from "vitest";
import { createCursorCodec } from "../../../../lib/problem-deploy/handlers/shared/cursor-codec.js";

/**
 * Issue #862: DDB pagination cursor は ExclusiveStartKey にそのまま渡るので、 attacker が
 * 任意 shape の JSON を送れないよう allowlist + value 制約で shape を pin する共通 codec。
 * valid cursor は round-trip し、 allowlist 外キー / oversized / 非 string value は reject。
 */
const ALLOWED = new Set(["PK", "SK", "GSI1PK", "GSI1SK"]);

function buildCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("createCursorCodec", () => {
  it("should round-trip a valid key (encode then decode)", () => {
    const codec = createCursorCodec(ALLOWED);
    const key = { PK: "EVENT#X", SK: "META" };
    const decoded = codec.decode(codec.encode(key));
    expect(decoded).toEqual(key);
  });

  it("should decode a base64url cursor whose keys are all in the allowlist", () => {
    const codec = createCursorCodec(ALLOWED);
    const key = { GSI1PK: "TENANT#acme", GSI1SK: "2026-05-04T15:00:00.000Z" };
    expect(codec.decode(buildCursor(key))).toEqual(key);
  });

  it("should reject a cursor containing a key outside the allowlist", () => {
    const codec = createCursorCodec(ALLOWED);
    const evil = { PK: "EVENT#X", SK: "META", evilAttribute: "exfil" };
    expect(codec.decode(buildCursor(evil))).toBeUndefined();
  });

  it("should honor a different allowlist per codec instance", () => {
    const deployCodec = createCursorCodec(new Set(["PK", "SK", "GSI2PK", "GSI2SK"]));
    const key = { GSI2PK: "TEAMKEY#abc", GSI2SK: "META" };
    // deploy 用 codec では許可されるが、 events 用 allowlist では reject される。
    expect(deployCodec.decode(buildCursor(key))).toEqual(key);
    expect(createCursorCodec(ALLOWED).decode(buildCursor(key))).toBeUndefined();
  });

  it("should reject an oversized cursor (DoS guard)", () => {
    const codec = createCursorCodec(ALLOWED);
    expect(codec.decode("a".repeat(1024))).toBeUndefined();
  });

  it("should reject a cursor whose value is not a string", () => {
    const codec = createCursorCodec(ALLOWED);
    const evil = { PK: { $type: "S", value: "evil" } };
    expect(codec.decode(buildCursor(evil))).toBeUndefined();
  });

  it("should reject a cursor with an empty-string value", () => {
    const codec = createCursorCodec(ALLOWED);
    expect(codec.decode(buildCursor({ PK: "" }))).toBeUndefined();
  });

  it("should reject a cursor whose value exceeds the per-value length limit", () => {
    const codec = createCursorCodec(ALLOWED);
    expect(codec.decode(buildCursor({ PK: "x".repeat(257) }))).toBeUndefined();
  });

  it("should reject a non-object JSON cursor (array / primitive)", () => {
    const codec = createCursorCodec(ALLOWED);
    expect(codec.decode(buildCursor(["PK"]))).toBeUndefined();
    expect(codec.decode(buildCursor("not-an-object"))).toBeUndefined();
    expect(codec.decode(buildCursor(null))).toBeUndefined();
  });

  it("should reject a malformed (non-base64 / non-JSON) cursor", () => {
    const codec = createCursorCodec(ALLOWED);
    expect(codec.decode("!!!not-valid!!!")).toBeUndefined();
  });
});
