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

it("retired cryptography is excluded across projections without dropping ordinary AWS entries", () => {
  const entries = { "ac26-crypto-battle": "retired", current: "current" };
  const filtered = cloudCatalog({
    catalog: entries,
    scoring: entries,
    runtimes: {},
    endpoints: {},
    phases: {},
    visibility: {},
    disruptions: {},
    coordination: {},
    coordinationBundles: {},
  });
  expect(filtered.catalog).toEqual({ current: "current" });
  expect(filtered.scoring).toEqual({ current: "current" });
});

it("handles legacy bundles with absent projections and excludes compose engines regardless of provider", () => {
  const legacy = { catalog: { current: "current" }, scoring: null } as unknown as Parameters<
    typeof cloudCatalog
  >[0];
  expect(cloudCatalog(legacy)).toEqual({ catalog: { current: "current" }, scoring: {} });
  const runtimesOnly = {
    runtimes: { local: { provider: "other", engine: "compose" } },
  } as unknown as Parameters<typeof cloudCatalog>[0];
  expect(cloudCatalog(runtimesOnly)).toEqual({ runtimes: {} });
});

it("excludes non-ac26 cryptography by source metadata tags from every projection", () => {
  const entries = { "ordinary-name": "retired", current: "current" };
  const filtered = cloudCatalog(
    {
      catalog: entries,
      scoring: entries,
      runtimes: {},
      endpoints: entries,
      phases: entries,
      visibility: entries,
      disruptions: entries,
      coordination: entries,
      coordinationBundles: entries,
    },
    {
      "ordinary-name": { tags: ["advanced-cryptography-course"] },
      current: { tags: ["security"] },
    },
  );
  for (const [name, projection] of Object.entries(filtered))
    expect(projection).toEqual(name === "runtimes" ? {} : { current: "current" });
});
