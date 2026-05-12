import { describe, expect, it } from "vitest";
import {
  parseEndpointSlot,
  parseEndpointsEnv,
  resolveDefaultUrl,
} from "../../lib/utils/endpoints-metadata";

describe("parseEndpointSlot", () => {
  it("最小構成 (= slot + default.from + default.key) を採用すべき", () => {
    expect(
      parseEndpointSlot({ slot: "main", default: { from: "cfn-output", key: "BaseUrl" } }),
    ).toEqual({
      slot: "main",
      default: { from: "cfn-output", key: "BaseUrl" },
      overridable: false,
    });
  });

  it("overridable=true / label / description / appendPath を保持すべき", () => {
    expect(
      parseEndpointSlot({
        slot: "users",
        default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
        overridable: true,
        label: "Users API",
        description: "顧客一覧",
      }),
    ).toEqual({
      slot: "users",
      default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
      overridable: true,
      label: "Users API",
      description: "顧客一覧",
    });
  });

  it("from が cfn-output 以外なら undefined を返すべき", () => {
    expect(parseEndpointSlot({ slot: "x", default: { from: "manual", key: "Y" } })).toBeUndefined();
  });

  it("slot が空文字 / key が空文字なら undefined を返すべき", () => {
    expect(
      parseEndpointSlot({ slot: "", default: { from: "cfn-output", key: "Y" } }),
    ).toBeUndefined();
    expect(
      parseEndpointSlot({ slot: "main", default: { from: "cfn-output", key: "" } }),
    ).toBeUndefined();
  });
});

describe("parseEndpointsEnv", () => {
  it("`{ [problemId]: ProblemEndpointSlot[] }` を採用すべき", () => {
    const raw = JSON.stringify({
      "hello-world-battle": [
        { slot: "frontend", default: { from: "cfn-output", key: "FrontendUrl" } },
        { slot: "api", default: { from: "cfn-output", key: "ApiUrl" } },
      ],
    });
    expect(parseEndpointsEnv(raw)).toEqual({
      "hello-world-battle": [
        {
          slot: "frontend",
          default: { from: "cfn-output", key: "FrontendUrl" },
          overridable: false,
        },
        {
          slot: "api",
          default: { from: "cfn-output", key: "ApiUrl" },
          overridable: false,
        },
      ],
    });
  });

  it("空文字 / 不正 JSON / non-object は空 map を返すべき", () => {
    expect(parseEndpointsEnv(undefined)).toEqual({});
    expect(parseEndpointsEnv("")).toEqual({});
    expect(parseEndpointsEnv("{not-json")).toEqual({});
    expect(parseEndpointsEnv("[1,2,3]")).toEqual({});
  });

  it("配列でない値 / 空配列の problemId は drop すべき", () => {
    const raw = JSON.stringify({
      "p-1": "not-array",
      "p-2": [],
      "p-3": [{ slot: "main", default: { from: "cfn-output", key: "X" } }],
    });
    expect(Object.keys(parseEndpointsEnv(raw))).toEqual(["p-3"]);
  });

  it("壊れた entry は drop し他は維持すべき", () => {
    const raw = JSON.stringify({
      "p-1": [
        { slot: "good", default: { from: "cfn-output", key: "X" } },
        { slot: "", default: { from: "cfn-output", key: "Y" } }, // empty slot → drop
        { slot: "bad-from", default: { from: "manual", key: "Z" } }, // from not cfn-output → drop
      ],
    });
    expect(parseEndpointsEnv(raw)).toEqual({
      "p-1": [
        {
          slot: "good",
          default: { from: "cfn-output", key: "X" },
          overridable: false,
        },
      ],
    });
  });
});

describe("resolveDefaultUrl", () => {
  it("appendPath 無しは base をそのまま返すべき", () => {
    expect(resolveDefaultUrl("https://example.com/")).toBe("https://example.com/");
    expect(resolveDefaultUrl("https://example.com")).toBe("https://example.com");
  });

  it("appendPath を相対 path として base に合成すべき", () => {
    expect(resolveDefaultUrl("https://example.com/", "/users")).toBe("https://example.com/users");
    expect(resolveDefaultUrl("https://example.com", "users")).toBe("https://example.com/users");
  });

  it("appendPath が絶対 URL なら appendPath を採用すべき", () => {
    expect(resolveDefaultUrl("https://base.example.com/", "https://other.example.com/path")).toBe(
      "https://other.example.com/path",
    );
  });
});
