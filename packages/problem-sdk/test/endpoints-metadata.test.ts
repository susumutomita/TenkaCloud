/**
 * [Problem SDK / Issue #2106] Direct unit tests for the pure endpoints-metadata
 * parser and the default-URL resolver — the durable public contract.
 */

import { describe, expect, it } from "vitest";
import { parseEndpointSlot, resolveDefaultUrl } from "../src/endpoints-metadata.js";

describe("parseEndpointSlot", () => {
  it("should parse a minimal cfn-output endpoint slot", () => {
    expect(parseEndpointSlot({ slot: "web", default: { from: "cfn-output", key: "Url" } })).toEqual(
      {
        slot: "web",
        default: { from: "cfn-output", key: "Url" },
        overridable: false,
      },
    );
  });

  it("should parse a full slot with appendPath, overridable, label, and description", () => {
    expect(
      parseEndpointSlot({
        slot: "api",
        default: { from: "cfn-output", key: "ApiUrl", appendPath: "/users" },
        overridable: true,
        label: "API",
        description: "the API base URL",
      }),
    ).toEqual({
      slot: "api",
      default: { from: "cfn-output", key: "ApiUrl", appendPath: "/users" },
      overridable: true,
      label: "API",
      description: "the API base URL",
    });
  });

  it("should reject a missing slot, missing/invalid default, or non-cfn-output source", () => {
    expect(parseEndpointSlot(undefined)).toBeUndefined();
    expect(parseEndpointSlot({ default: { from: "cfn-output", key: "Url" } })).toBeUndefined();
    expect(parseEndpointSlot({ slot: "web" })).toBeUndefined();
    expect(
      parseEndpointSlot({ slot: "web", default: { from: "env", key: "Url" } }),
    ).toBeUndefined();
    expect(parseEndpointSlot({ slot: "web", default: { from: "cfn-output" } })).toBeUndefined();
  });
});

describe("resolveDefaultUrl", () => {
  it("should return the base when no appendPath is given", () => {
    expect(resolveDefaultUrl("https://example.com")).toBe("https://example.com");
  });

  it("should join a relative appendPath onto the base", () => {
    expect(resolveDefaultUrl("https://example.com", "/users")).toBe("https://example.com/users");
    expect(resolveDefaultUrl("https://example.com/api", "users")).toBe(
      "https://example.com/api/users",
    );
  });

  it("should prefer an absolute-URL appendPath", () => {
    expect(resolveDefaultUrl("https://example.com", "https://other.test/x")).toBe(
      "https://other.test/x",
    );
  });

  it("should return undefined when the base is unusable", () => {
    expect(resolveDefaultUrl("not a url", "/users")).toBeUndefined();
  });
});
