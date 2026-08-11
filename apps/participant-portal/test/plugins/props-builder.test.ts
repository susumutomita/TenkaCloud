import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemCatalogEntry } from "../../src/data/problems";
import {
  buildPortalDisruptions,
  buildPortalEndpointsFromOutputs,
  buildPortalEndpointsFromRegistry,
  buildPortalPhases,
  buildPortalTeam,
} from "../../src/plugins/props-builder";

/**
 * props-builder は build-time catalog (`findProblemMetadata`) を消費して
 * SDK の PortalSlotProps shape に marshal する純関数群。 catalog 実データに依存させず
 * `findProblemMetadata` を mock して各分岐 (= endpoint URL 結合 / fail-closed publicHint
 * filter / 不正 URL の context-rethrow / optional field の narrow) を決定論的に pin する。
 */
const { findProblemMetadata } = vi.hoisted(() => ({ findProblemMetadata: vi.fn() }));
vi.mock("../../src/data/problems", () => ({ findProblemMetadata }));

// props-builder が読む field (endpoints / phases / disruptions) のみ詰めた最小 entry。
function entry(overrides: Partial<ProblemCatalogEntry>): ProblemCatalogEntry {
  return {
    endpoints: [],
    phases: [],
    disruptions: [],
    ...overrides,
  } as unknown as ProblemCatalogEntry;
}

beforeEach(() => findProblemMetadata.mockReset());

describe("buildPortalEndpointsFromOutputs", () => {
  it("should return [] when the problem has no metadata", () => {
    findProblemMetadata.mockReturnValue(undefined);
    expect(buildPortalEndpointsFromOutputs("missing", {})).toEqual([]);
  });

  it("should return [] when the metadata declares no endpoints", () => {
    findProblemMetadata.mockReturnValue(entry({ endpoints: [] }));
    expect(buildPortalEndpointsFromOutputs("p", { BaseUrl: "https://api.example.com" })).toEqual(
      [],
    );
  });

  it("should join base + appendPath into default/effective URLs from stack outputs", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          {
            slot: "users",
            overridable: true,
            default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
          },
        ],
      }),
    );
    const out = buildPortalEndpointsFromOutputs("p", { BaseUrl: "https://api.example.com" });
    expect(out).toEqual([
      {
        slot: "users",
        overridable: true,
        defaultUrl: "https://api.example.com/users",
        effectiveUrl: "https://api.example.com/users",
      },
    ]);
  });

  it("should not double the slash when the base already ends with '/'", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          {
            slot: "users",
            overridable: true,
            default: { from: "cfn-output", key: "BaseUrl", appendPath: "users" },
          },
        ],
      }),
    );
    const out = buildPortalEndpointsFromOutputs("p", { BaseUrl: "https://api.example.com/" });
    expect(out[0]?.defaultUrl).toBe("https://api.example.com/users");
  });

  it("should use the bare base URL when no appendPath is declared", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          { slot: "api", overridable: false, default: { from: "cfn-output", key: "Url" } },
        ],
      }),
    );
    const out = buildPortalEndpointsFromOutputs("p", { Url: "https://h.example/path" });
    expect(out[0]?.defaultUrl).toBe("https://h.example/path");
    expect(out[0]?.effectiveUrl).toBe("https://h.example/path");
    expect(out[0]?.overridable).toBe(false);
  });

  it("should carry optional label / description through to the endpoint", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          {
            slot: "api",
            overridable: true,
            label: "Users API",
            description: "The users microservice",
            default: { from: "cfn-output", key: "Url" },
          },
        ],
      }),
    );
    const out = buildPortalEndpointsFromOutputs("p", { Url: "https://e.example" });
    expect(out[0]?.label).toBe("Users API");
    expect(out[0]?.description).toBe("The users microservice");
  });

  it("should omit URLs when the stack output for the key is absent (not yet deployed)", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          { slot: "api", overridable: true, default: { from: "cfn-output", key: "Missing" } },
        ],
      }),
    );
    const out = buildPortalEndpointsFromOutputs("p", {});
    expect(out).toEqual([{ slot: "api", overridable: true }]);
    expect(out[0]?.defaultUrl).toBeUndefined();
  });

  it("should rethrow a malformed base URL with problemId / slot / key context (no silent skip)", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        endpoints: [
          {
            slot: "users",
            overridable: true,
            default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
          },
        ],
      }),
    );
    expect(() =>
      buildPortalEndpointsFromOutputs("battle-x", { BaseUrl: "not-a-valid-base" }),
    ).toThrow(/Failed to build endpoint URL for problemId=battle-x slot=users key=BaseUrl/);
  });
});

describe("buildPortalEndpointsFromRegistry", () => {
  it("should preserve an override as the effective URL when the default output is empty", () => {
    expect(
      buildPortalEndpointsFromRegistry([
        {
          slot: "app",
          overridable: true,
          defaultKey: "RegisteredUrl",
          overrideUrl: "https://app.example.com",
          effectiveUrl: "https://app.example.com",
        },
      ]),
    ).toEqual([
      {
        slot: "app",
        overridable: true,
        overrideUrl: "https://app.example.com",
        effectiveUrl: "https://app.example.com",
      },
    ]);
  });

  it("should return the server default after an override is cleared", () => {
    expect(
      buildPortalEndpointsFromRegistry([
        {
          slot: "app",
          overridable: true,
          defaultKey: "RegisteredUrl",
          defaultUrl: "https://default.example.com",
          effectiveUrl: "https://default.example.com",
        },
      ]),
    ).toEqual([
      {
        slot: "app",
        overridable: true,
        defaultUrl: "https://default.example.com",
        effectiveUrl: "https://default.example.com",
      },
    ]);
  });
});

describe("buildPortalPhases hides entries unless publicHint is true", () => {
  it("should return [] when the problem has no metadata", () => {
    findProblemMetadata.mockReturnValue(undefined);
    expect(buildPortalPhases("missing")).toEqual([]);
  });

  it("should keep only phases explicitly flagged publicHint: true", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        phases: [
          { name: "reveal", afterMinutes: 5, publicHint: true },
          { name: "hidden", afterMinutes: 10, publicHint: false },
          { name: "default-hidden", afterMinutes: 15 },
        ],
      }),
    );
    expect(buildPortalPhases("p")).toEqual([{ name: "reveal", afterMinutes: 5, publicHint: true }]);
  });
});

describe("buildPortalDisruptions hides entries unless publicHint is true", () => {
  it("should return [] when the problem has no metadata", () => {
    findProblemMetadata.mockReturnValue(undefined);
    expect(buildPortalDisruptions("missing")).toEqual([]);
  });

  it("should keep only disruptions explicitly flagged publicHint: true", () => {
    findProblemMetadata.mockReturnValue(
      entry({
        disruptions: [
          { id: "d1", name: "Announced", publicHint: true },
          { id: "d2", name: "Surprise", publicHint: false },
        ],
      }),
    );
    expect(buildPortalDisruptions("p")).toEqual([
      { id: "d1", name: "Announced", publicHint: true },
    ]);
  });
});

describe("buildPortalTeam (narrow undefined optionals for exactOptionalPropertyTypes)", () => {
  it("should keep only teamName when teamId / eventId are absent", () => {
    expect(buildPortalTeam({ teamName: "Alpha" })).toEqual({ teamName: "Alpha" });
  });

  it("should include teamId / eventId when present", () => {
    expect(buildPortalTeam({ teamName: "Alpha", teamId: "t1", eventId: "e1" })).toEqual({
      teamName: "Alpha",
      teamId: "t1",
      eventId: "e1",
    });
  });

  it("should include teamId but drop an absent eventId", () => {
    expect(buildPortalTeam({ teamName: "Alpha", teamId: "t1" })).toEqual({
      teamName: "Alpha",
      teamId: "t1",
    });
  });
});
