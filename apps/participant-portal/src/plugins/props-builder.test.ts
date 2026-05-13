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
  it("metadata.endpoints[] と stackOutputs から effectiveUrl を組み立てるべき", () => {
    const endpoints = buildPortalEndpointsFromOutputs("microservice-migration-battle", {
      BaseUrl: "http://ec2-1-2-3-4.compute.amazonaws.com",
    });
    expect(endpoints).toHaveLength(3);
    const users = endpoints.find((e) => e.slot === "users");
    expect(users?.defaultUrl).toBe("http://ec2-1-2-3-4.compute.amazonaws.com/users");
    expect(users?.effectiveUrl).toBe("http://ec2-1-2-3-4.compute.amazonaws.com/users");
    expect(users?.overridable).toBe(true);
  });

  it("stackOutputs に該当 key が無いなら defaultUrl は undefined にすべき", () => {
    const endpoints = buildPortalEndpointsFromOutputs("microservice-migration-battle", {});
    expect(endpoints[0]?.defaultUrl).toBeUndefined();
    expect(endpoints[0]?.effectiveUrl).toBeUndefined();
  });

  it("metadata.endpoints[] が無い問題 (hello-world) は空配列を返すべき", () => {
    expect(buildPortalEndpointsFromOutputs("hello-world", {})).toEqual([]);
  });

  it("存在しない problemId は空配列を返すべき", () => {
    expect(buildPortalEndpointsFromOutputs("does-not-exist", {})).toEqual([]);
  });

  it("malformed base URL (CFn output が空文字 / 不正) は context 付きで throw すべき (= silent skip しない)", () => {
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
  it("phases[] が宣言済の問題は narrow 後 array を返すべき (effect は plugin に渡さない)", () => {
    const phases = buildPortalPhases("microservice-migration-battle");
    expect(phases.length).toBeGreaterThanOrEqual(2);
    // operator 内部 field (effect) が plugin に渡らない (= 答えの hint や noise を防ぐ)
    const json = JSON.stringify(phases);
    expect(json).not.toContain("switchPlatformToDegraded");
    expect(json).not.toContain("scorePathOverride");
  });

  it("phases[] が無い問題は空配列を返すべき", () => {
    expect(buildPortalPhases("hello-world")).toEqual([]);
  });
});

describe("buildPortalDisruptions", () => {
  it("disruptions[] が無い問題は空配列を返すべき (= Phase 4 disruptions[] 未追加の場合)", () => {
    // disruptions[] は Phase 4 で microservice-migration-battle にのみ追加。
    // 他問題は disruptions[] 無しのため空配列。
    expect(buildPortalDisruptions("hello-world")).toEqual([]);
    expect(buildPortalDisruptions("hello-world-battle")).toEqual([]);
    expect(buildPortalDisruptions("security-battle-royale")).toEqual([]);
  });

  it("存在しない problemId は空配列を返すべき", () => {
    expect(buildPortalDisruptions("does-not-exist")).toEqual([]);
  });
});
