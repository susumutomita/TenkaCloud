import { describe, expect, it } from "vitest";
import {
  parseEndpointSlot,
  parseEndpointsEnv,
  resolveDefaultUrl,
} from "../../lib/utils/endpoints-metadata";

describe("parseEndpointSlot", () => {
  it("should adopt the minimal config (slot + default.from + default.key)", () => {
    expect(
      parseEndpointSlot({ slot: "main", default: { from: "cfn-output", key: "BaseUrl" } }),
    ).toEqual({
      slot: "main",
      default: { from: "cfn-output", key: "BaseUrl" },
      overridable: false,
    });
  });

  it("should preserve overridable=true / label / description / appendPath", () => {
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

  it("should return undefined when from is anything other than cfn-output", () => {
    expect(parseEndpointSlot({ slot: "x", default: { from: "manual", key: "Y" } })).toBeUndefined();
  });

  it("should return undefined when slot or key is empty", () => {
    expect(
      parseEndpointSlot({ slot: "", default: { from: "cfn-output", key: "Y" } }),
    ).toBeUndefined();
    expect(
      parseEndpointSlot({ slot: "main", default: { from: "cfn-output", key: "" } }),
    ).toBeUndefined();
  });
});

describe("parseEndpointsEnv", () => {
  it("should adopt the `{ [problemId]: ProblemEndpointSlot[] }` shape", () => {
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

  it("should return an empty map for empty string / invalid JSON / non-object", () => {
    expect(parseEndpointsEnv(undefined)).toEqual({});
    expect(parseEndpointsEnv("")).toEqual({});
    expect(parseEndpointsEnv("{not-json")).toEqual({});
    expect(parseEndpointsEnv("[1,2,3]")).toEqual({});
  });

  it("should drop non-array values / empty-array problemId", () => {
    const raw = JSON.stringify({
      "p-1": "not-array",
      "p-2": [],
      "p-3": [{ slot: "main", default: { from: "cfn-output", key: "X" } }],
    });
    expect(Object.keys(parseEndpointsEnv(raw))).toEqual(["p-3"]);
  });

  it("should drop broken entries while keeping the rest", () => {
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
  it("should return the base as-is when there is no appendPath", () => {
    expect(resolveDefaultUrl("https://example.com/")).toBe("https://example.com/");
    expect(resolveDefaultUrl("https://example.com")).toBe("https://example.com");
  });

  it("should combine appendPath as a relative path onto the base", () => {
    expect(resolveDefaultUrl("https://example.com/", "/users")).toBe("https://example.com/users");
    expect(resolveDefaultUrl("https://example.com", "users")).toBe("https://example.com/users");
  });

  it("should use appendPath when it is an absolute URL", () => {
    expect(resolveDefaultUrl("https://base.example.com/", "https://other.example.com/path")).toBe(
      "https://other.example.com/path",
    );
  });
});
