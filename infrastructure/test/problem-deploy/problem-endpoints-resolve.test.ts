import { describe, expect, it } from "vitest";
import { resolveEndpoints } from "../../lib/problem-deploy/handlers/problem-endpoints-handler/resolve";
import type { EndpointOverrideItem } from "../../lib/problem-deploy/handlers/problem-endpoints-handler/store";
import type { ProblemEndpointSlot } from "../../lib/utils/endpoints-metadata";

/**
 * resolveEndpoints は純関数なので vi.mock 不要。metadata + stackOutputs (= CFn output JSON) +
 * override 行を merge して effective URL を組む。
 */

const slot = (
  name: string,
  key: string,
  opts: Partial<ProblemEndpointSlot> = {},
): ProblemEndpointSlot => ({
  slot: name,
  default: { from: "cfn-output", key },
  overridable: false,
  ...opts,
});

const override = (slotName: string, url: string): EndpointOverrideItem => ({
  PK: "TENANT#t#TEAM#tm#PROBLEM#p",
  SK: `SLOT#${slotName}`,
  tenantId: "t",
  teamId: "tm",
  problemId: "p",
  slot: slotName,
  overrideUrl: url,
  updatedAt: "2026-05-12T00:00:00.000Z",
});

describe("resolveEndpoints", () => {
  it("CFn output 値を default URL として採用すべき (array 形式)", () => {
    const stackOutputs = JSON.stringify([
      { OutputKey: "FrontendUrl", OutputValue: "https://front.example.com/" },
    ]);
    const result = resolveEndpoints({
      slots: [slot("frontend", "FrontendUrl")],
      stackOutputs,
      overrides: [],
    });
    expect(result).toEqual([
      {
        slot: "frontend",
        overridable: false,
        defaultKey: "FrontendUrl",
        defaultUrl: "https://front.example.com/",
        effectiveUrl: "https://front.example.com/",
      },
    ]);
  });

  it("CFn output に該当 key が無いとき defaultUrl は undefined、effectiveUrl も undefined になるべき", () => {
    const result = resolveEndpoints({
      slots: [slot("api", "MissingKey")],
      stackOutputs: JSON.stringify([]),
      overrides: [],
    });
    // #703: defaultKey は metadata 由来なので stackOutputs に無くても露出して UI 側 hint に使う
    expect(result).toEqual([{ slot: "api", overridable: false, defaultKey: "MissingKey" }]);
  });

  it("override がある slot は effectiveUrl が override で埋まるべき", () => {
    const stackOutputs = JSON.stringify([
      { OutputKey: "FrontendUrl", OutputValue: "https://front.example.com/" },
    ]);
    const result = resolveEndpoints({
      slots: [slot("frontend", "FrontendUrl", { overridable: true })],
      stackOutputs,
      overrides: [override("frontend", "https://my-host.example.com/")],
    });
    expect(result[0]).toMatchObject({
      defaultUrl: "https://front.example.com/",
      overrideUrl: "https://my-host.example.com/",
      effectiveUrl: "https://my-host.example.com/",
    });
  });

  it("appendPath を含めた default URL を組み立てるべき", () => {
    const stackOutputs = JSON.stringify([
      { OutputKey: "BaseUrl", OutputValue: "https://api.example.com/" },
    ]);
    const result = resolveEndpoints({
      slots: [
        slot("users", "BaseUrl", {
          default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
        }),
      ],
      stackOutputs,
      overrides: [],
    });
    expect(result[0]?.defaultUrl).toBe("https://api.example.com/users");
  });

  it("label / description を保持すべき", () => {
    const result = resolveEndpoints({
      slots: [slot("frontend", "FrontendUrl", { label: "Frontend", description: "nginx" })],
      stackOutputs: undefined,
      overrides: [],
    });
    expect(result[0]).toMatchObject({
      label: "Frontend",
      description: "nginx",
      overridable: false,
    });
  });

  it("metadata.endpoints[] が空なら空配列を返すべき", () => {
    expect(resolveEndpoints({ slots: [], stackOutputs: undefined, overrides: [] })).toEqual([]);
  });
});
