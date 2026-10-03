import { describe, expect, it } from "vitest";
import { cloudCatalog } from "../../lib/cloud-hosting/catalog.js";

describe("cloud catalog boundary", () => {
  it("excludes a composite with a local target while retaining a cloud-only composite", () => {
    const result = cloudCatalog({
      catalog: { mixed: "mixed", cloudOnly: "cloud" },
      scoring: {},
      endpoints: {},
      phases: {},
      visibility: {},
      disruptions: {},
      coordination: {},
      coordinationBundles: {},
      runtimes: {
        mixed: {
          kind: "composite",
          targets: [
            { provider: "aws", engine: "cloudformation" },
            { provider: "docker", engine: "compose" },
          ],
        },
        cloudOnly: {
          kind: "composite",
          targets: [
            { provider: "aws", engine: "cloudformation" },
            { provider: "sakura", engine: "apprun" },
          ],
        },
      },
    });
    expect(result.catalog).toEqual({ cloudOnly: "cloud" });
    expect(result.runtimes).not.toHaveProperty("mixed");
    expect(result.runtimes).toHaveProperty("cloudOnly");
  });

  it("removes arbitrary Docker/Compose exercises from every projection while keeping AWS and native exercises", () => {
    const entries = { arbitraryLocal: "local", arbitraryAws: "aws", arbitraryNative: "native" };
    const result = cloudCatalog({
      catalog: entries,
      scoring: entries,
      endpoints: entries,
      phases: entries,
      visibility: entries,
      disruptions: entries,
      coordination: entries,
      coordinationBundles: entries,
      writeups: entries,
      provenance: entries,
      runtimes: { arbitraryLocal: { provider: "docker", engine: "compose" } },
    });
    expect(result.runtimes).toEqual({});
    for (const [name, value] of Object.entries(result)) {
      if (name !== "runtimes")
        expect(value).toEqual({ arbitraryAws: "aws", arbitraryNative: "native" });
    }
    expect(entries).toHaveProperty("arbitraryLocal");
  });
});
