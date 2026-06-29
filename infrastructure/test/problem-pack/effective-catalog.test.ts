/**
 * [Problem Packs / Issue #2091] Tests for the pure effective-catalog composer.
 *
 * The composer takes ALREADY-LOADED core problems and ALREADY-VALIDATED pack
 * snapshot inputs and merges them, retaining provenance. These tests therefore
 * use plain in-memory objects only: no filesystem, no temp dirs, no mocks, no
 * network — proving the composer's purity by construction. `mock`/`vi` for the
 * `node:fs` and `node:https` modules would be a spy that never fires, so instead
 * the "pure" test asserts the function reference touches no I/O module at all.
 */

import { describe, expect, it } from "vitest";
import {
  type ComposeEffectiveCatalogInput,
  type CoreProblemInput,
  composeEffectiveCatalog,
  type PackSnapshotInput,
  type PlatformContext,
} from "../../lib/problem-pack/effective-catalog";
import type { PackManifest } from "../../lib/problem-pack/manifest";

const PLATFORM: PlatformContext = {
  coreVersion: "1.4.0",
  availableRuntimes: [
    { provider: "aws", engine: "cloudformation" },
    { provider: "gcp", engine: "infra-manager" },
  ],
};

function coreProblem(id: string, overrides: Partial<CoreProblemInput> = {}): CoreProblemInput {
  return {
    problemId: id,
    directory: `problems/challenges/${id}`,
    projections: { scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 } },
    ...overrides,
  };
}

function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    schemaVersion: 1,
    id: "com.example.pack",
    version: "1.0.0",
    core: "^1.0.0",
    title: "Example pack",
    description: "An example pack.",
    license: "Apache-2.0",
    problemsRoot: "problems",
    requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    ...overrides,
  };
}

function pack(overrides: Partial<PackSnapshotInput> = {}): PackSnapshotInput {
  return {
    manifest: manifest(),
    contentDigest: "a".repeat(64),
    problems: [
      {
        problemId: "pack-problem",
        directory: "problems/challenges/pack-problem",
        projections: { scoring: { kind: "flag", flagOutputKey: "Flag", points: 50 } },
      },
    ],
    ...overrides,
  };
}

function compose(overrides: Partial<ComposeEffectiveCatalogInput> = {}) {
  return composeEffectiveCatalog({
    core: [],
    packs: [],
    platform: PLATFORM,
    ...overrides,
  });
}

describe("composeEffectiveCatalog (#2091)", () => {
  it("should merge core and a pack snapshot, retaining provenance per problem", () => {
    const result = compose({ core: [coreProblem("hello-world")], packs: [pack()] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      problemId: "hello-world",
      directory: "problems/challenges/hello-world",
      provenance: { source: "core" },
    });
    expect(result.entries[1]).toMatchObject({
      problemId: "pack-problem",
      directory: "problems/challenges/pack-problem",
      provenance: {
        source: "pack",
        packId: "com.example.pack",
        packVersion: "1.0.0",
        contentDigest: "a".repeat(64),
      },
    });
  });

  it("should keep core entries with source=core and carry their projections through", () => {
    const result = compose({ core: [coreProblem("only-core")] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provenance).toEqual({ source: "core" });
    expect(result.entries[0].projections).toEqual({
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    });
  });

  it("should equal the current core catalog when no packs are installed (core-only)", () => {
    const core = [coreProblem("alpha"), coreProblem("bravo")];
    const result = compose({ core });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.problemId)).toEqual(["alpha", "bravo"]);
    expect(result.entries.every((e) => e.provenance.source === "core")).toBe(true);
  });

  it("should add problems when one pack is installed alongside core", () => {
    const result = compose({ core: [coreProblem("core-1")], packs: [pack()] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.problemId)).toEqual(["core-1", "pack-problem"]);
  });

  it("should fail when a pack problem id duplicates a core id, naming both identities", () => {
    const result = compose({
      core: [coreProblem("clash")],
      packs: [pack({ problems: [{ problemId: "clash", directory: "d", projections: {} }] })],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DUPLICATE_PROBLEM_ID");
    expect(result.message).toContain("clash");
    expect(result.message).toContain("core");
    expect(result.message).toContain("com.example.pack@1.0.0");
  });

  it("should fail when two packs declare the same problem id, naming both packs", () => {
    const packA = pack({
      manifest: manifest({ id: "com.a.pack", version: "1.0.0" }),
      problems: [{ problemId: "shared", directory: "d", projections: {} }],
    });
    const packB = pack({
      manifest: manifest({ id: "com.b.pack", version: "2.0.0" }),
      problems: [{ problemId: "shared", directory: "d", projections: {} }],
    });

    const result = compose({ packs: [packA, packB] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DUPLICATE_PROBLEM_ID");
    expect(result.message).toContain("com.a.pack@1.0.0");
    expect(result.message).toContain("com.b.pack@2.0.0");
  });

  it("should not let a pack override a core problem (core wins, conflict reported)", () => {
    const result = compose({
      core: [coreProblem("hello-world")],
      packs: [
        pack({ problems: [{ problemId: "hello-world", directory: "override", projections: {} }] }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DUPLICATE_PROBLEM_ID");
    expect(result.message).toContain("cannot override core");
  });

  it("should fail when a required runtime capability is unavailable on the platform", () => {
    const result = compose({
      packs: [
        pack({
          manifest: manifest({ requiredRuntimes: [{ provider: "azure", engine: "bicep" }] }),
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("RUNTIME_UNAVAILABLE");
    expect(result.message).toContain("azure/bicep");
  });

  it("should fail when the platform core does not satisfy the manifest core range", () => {
    const result = compose({
      packs: [pack({ manifest: manifest({ core: "^2.0.0" }) })],
      platform: { ...PLATFORM, coreVersion: "1.4.0" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CORE_RANGE_UNSATISFIED");
    expect(result.message).toContain("^2.0.0");
    expect(result.message).toContain("1.4.0");
  });

  it("should order entries deterministically: core first, then packId/version/problemId", () => {
    const core = [coreProblem("zeta"), coreProblem("alpha")];
    const packLater = pack({
      manifest: manifest({ id: "com.z.pack", version: "1.0.0" }),
      problems: [
        { problemId: "z-second", directory: "d", projections: {} },
        { problemId: "z-first", directory: "d", projections: {} },
      ],
    });
    const packEarlier = pack({
      manifest: manifest({ id: "com.a.pack", version: "1.0.0" }),
      problems: [{ problemId: "a-only", directory: "d", projections: {} }],
    });

    const first = compose({ core, packs: [packLater, packEarlier] });
    // Reversed input order must yield the same output order (stable, not input-derived).
    const second = compose({ core: [...core].reverse(), packs: [packEarlier, packLater] });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.entries.map((e) => e.problemId)).toEqual([
      "zeta", // core preserves its given order
      "alpha",
      "a-only", // com.a.pack before com.z.pack
      "z-first", // within com.z.pack, problemId-sorted
      "z-second",
    ]);
    // Core order is the only input-order-sensitive part; packs are fully stable.
    expect(second.entries.map((e) => e.problemId)).toEqual([
      "alpha",
      "zeta",
      "a-only",
      "z-first",
      "z-second",
    ]);
  });

  it("should be pure: the same input yields a deeply equal result every call", () => {
    const input: ComposeEffectiveCatalogInput = {
      core: [coreProblem("alpha")],
      packs: [pack()],
      platform: PLATFORM,
    };

    expect(composeEffectiveCatalog(input)).toEqual(composeEffectiveCatalog(input));
  });

  it("should not mutate the caller's input arrays while ordering", () => {
    const packs = [
      pack({ manifest: manifest({ id: "com.z.pack" }) }),
      pack({ manifest: manifest({ id: "com.a.pack" }) }),
    ];
    const before = packs.map((p) => p.manifest.id);

    composeEffectiveCatalog({ core: [], packs, platform: PLATFORM });

    expect(packs.map((p) => p.manifest.id)).toEqual(before);
  });

  it("should reference no filesystem or network module in its source (pure by construction)", async () => {
    // Reading the composer's own source and asserting it imports no I/O module
    // is a structural guarantee that the function cannot touch FS / network.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const source = fs.readFileSync(
      url.fileURLToPath(new URL("../../lib/problem-pack/effective-catalog.ts", import.meta.url)),
      "utf-8",
    );
    expect(source).not.toMatch(/node:fs/);
    expect(source).not.toMatch(/node:https?/);
    expect(source).not.toMatch(/node:net/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
