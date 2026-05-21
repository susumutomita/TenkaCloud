import { describe, expect, it } from "vitest";
import {
  buildPortalDisruptions,
  buildPortalEndpointsFromOutputs,
  buildPortalPhases,
} from "./props-builder";

/**
 * ADR-012 Phase 5: portal が plugin に渡す PortalSlotProps を組み立てる純関数の pin test。
 * metadata 由来の operator 内部 field (effect / parameters / eventDetailType) が plugin に
 * 漏れないことを assertion で確認 (= "portal は plugin の信頼境界" 原則)。
 */
describe("buildPortalEndpointsFromOutputs", () => {
  it("should build effectiveUrl from metadata.endpoints[] and stackOutputs", () => {
    const endpoints = buildPortalEndpointsFromOutputs("microservice-migration-battle", {
      BaseUrl: "http://ec2-1-2-3-4.compute.amazonaws.com",
    });
    expect(endpoints).toHaveLength(3);
    const users = endpoints.find((e) => e.slot === "users");
    expect(users?.defaultUrl).toBe("http://ec2-1-2-3-4.compute.amazonaws.com/users");
    expect(users?.effectiveUrl).toBe("http://ec2-1-2-3-4.compute.amazonaws.com/users");
    expect(users?.overridable).toBe(true);
  });

  it("should leave defaultUrl undefined when stackOutputs lacks the key", () => {
    const endpoints = buildPortalEndpointsFromOutputs("microservice-migration-battle", {});
    expect(endpoints[0]?.defaultUrl).toBeUndefined();
    expect(endpoints[0]?.effectiveUrl).toBeUndefined();
  });

  it("should return empty array for a problem (hello-world) without metadata.endpoints[]", () => {
    expect(buildPortalEndpointsFromOutputs("hello-world", {})).toEqual([]);
  });

  it("should return empty array for a non-existent problemId", () => {
    expect(buildPortalEndpointsFromOutputs("does-not-exist", {})).toEqual([]);
  });

  it("should throw with context for malformed base URL (CFn output empty / invalid) (= no silent skip)", () => {
    // base に malformed URL を投入し joinUrl で `new URL("/users", "not-a-url/")` が
    // throw する case。 silent undefined fallback は metadata / output 異常を隠してしまうので、
    // context (= problemId / slot / key) 付き Error を rethrow することで debuggable にする。
    expect(() =>
      buildPortalEndpointsFromOutputs("microservice-migration-battle", {
        BaseUrl: "not-a-valid-url",
      }),
    ).toThrow(/microservice-migration-battle/);
  });
});

describe("buildPortalPhases", () => {
  it("should return only phases with publicHint=true (#689 — spoiler prevention)", () => {
    // microservice-migration-battle は phases[] に degraded / legacy を持つが、 default
    // (= publicHint 未指定) では portal に出さない。 metadata 作者が明示的に publicHint=true
    // を立てた entry のみ portal に届く。
    const phases = buildPortalPhases("microservice-migration-battle");
    expect(phases.every((p) => p.publicHint === true)).toBe(true);
  });

  it("should not leak operator-internal fields (= effect / switchPlatformToDegraded) to plugins", () => {
    const phases = buildPortalPhases("microservice-migration-battle");
    const json = JSON.stringify(phases);
    expect(json).not.toContain("switchPlatformToDegraded");
    expect(json).not.toContain("scorePathOverride");
  });

  it("should return empty array for problems without phases[]", () => {
    expect(buildPortalPhases("hello-world")).toEqual([]);
  });
});

describe("buildPortalDisruptions", () => {
  it("should return only disruptions with publicHint=true (#689 — spoiler prevention)", () => {
    const out = buildPortalDisruptions("microservice-migration-battle");
    expect(out.every((d) => d.publicHint === true)).toBe(true);
  });

  it("should return empty array for problems without disruptions[]", () => {
    expect(buildPortalDisruptions("hello-world")).toEqual([]);
    expect(buildPortalDisruptions("hello-world-battle")).toEqual([]);
    expect(buildPortalDisruptions("security-battle-royale")).toEqual([]);
  });

  it("should return empty array for a non-existent problemId", () => {
    expect(buildPortalDisruptions("does-not-exist")).toEqual([]);
  });
});
