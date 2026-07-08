/**
 * [Problem Packs / Issue #2092] Tests for the catalog SOURCE ABSTRACTION.
 *
 * The abstraction lets the backend deployment paths consume ONE effective catalog
 * (the {@link ProblemsCatalogBundle}: catalog / scoring / endpoints / phases /
 * visibility / runtimes / disruptions / coordination / coordinationBundles) without
 * depending DIRECTLY on the single local `problems/` tree.
 *
 * Two adapters are tested over the REAL filesystem (temp dirs, no FS mocks):
 *   - {@link LocalCatalogSource} reproduces the current synth-time behavior
 *     byte-identically — its bundle equals the result of calling the existing
 *     `discoverProblems*` extractors directly (#2086 is the guard).
 *   - {@link SnapshotCatalogSource} composes core + installed pack snapshots and is
 *     DORMANT by default: with no installed packs its bundle equals the core-only
 *     bundle, so the default code path is unchanged.
 *
 * Coordination plugin BUNDLING (esbuild) is exercised separately by the existing
 * `bundle-coordination-plugins` path; the fixtures here declare no plugins, so the
 * `coordinationBundles` projection is `{}` for both the adapter and the baseline.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalCatalogSource, SnapshotCatalogSource } from "../../lib/problem-pack/catalog-source";
import {
  discoverProblemsCatalog,
  discoverProblemsCoordination,
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsRuntime,
  discoverProblemsScoring,
  discoverProblemsVisibility,
} from "../../lib/utils/discover-problems-catalog";

let root: string;

function writeProblem(category: string, dir: string, metadata: unknown): void {
  const target = path.join(root, category, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(metadata));
}

/** Populate a representative local catalog touching every projection. */
function writeRepresentativeCatalog(): void {
  writeProblem("challenges", "hello-world", {
    id: "hello-world",
    scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    visibility: "public",
  });
  writeProblem("challenges", "private-payload", {
    id: "private-payload",
    visibility: "private",
    scoring: { kind: "flag", flagOutputKey: "Secret", points: 200 },
  });
  writeProblem("battles", "uptime-battle", {
    id: "uptime-battle",
    scoring: {
      kind: "uptime",
      endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
      pointsPerSuccess: 50,
    },
    endpoints: [
      {
        slot: "frontend",
        default: { from: "cfn-output", key: "FrontendUrl", appendPath: "/health" },
        overridable: true,
        label: "FE",
        description: "frontend",
      },
    ],
    phases: [
      { name: "warmup", afterMinutes: 0 },
      { name: "attack", afterMinutes: 30 },
    ],
    disruptions: [{ id: "latency", name: "Latency", eventDetailType: "DegradedFired" }],
  });
  writeProblem("challenges", "container-only", {
    id: "container-only",
    runtime: { provider: "docker", engine: "compose", entry: "local/docker-compose.yml" },
    scoring: { kind: "verify", points: 300 },
  });
}

/** The exact bundle the legacy `discoverAppProblems` path would produce (no plugin bundling). */
function baselineBundle(problemsRoot: string) {
  return {
    catalog: discoverProblemsCatalog(problemsRoot),
    scoring: discoverProblemsScoring(problemsRoot),
    endpoints: discoverProblemsEndpoints(problemsRoot),
    phases: discoverProblemsPhases(problemsRoot),
    visibility: discoverProblemsVisibility(problemsRoot),
    runtimes: discoverProblemsRuntime(problemsRoot),
    disruptions: discoverProblemsDisruptions(problemsRoot),
    coordination: discoverProblemsCoordination(problemsRoot),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-source-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalCatalogSource (#2092)", () => {
  it("should reproduce the current catalog/scoring/endpoints/etc. byte-identically", () => {
    writeRepresentativeCatalog();
    const baseline = baselineBundle(root);

    const bundle = new LocalCatalogSource().loadBundle(root);

    expect(bundle.catalog).toEqual(baseline.catalog);
    expect(bundle.scoring).toEqual(baseline.scoring);
    expect(bundle.endpoints).toEqual(baseline.endpoints);
    expect(bundle.phases).toEqual(baseline.phases);
    expect(bundle.visibility).toEqual(baseline.visibility);
    expect(bundle.runtimes).toEqual(baseline.runtimes);
    expect(bundle.disruptions).toEqual(baseline.disruptions);
    expect(bundle.coordination).toEqual(baseline.coordination);
  });

  it("should not change any existing problem IDs in the catalog projection", () => {
    writeRepresentativeCatalog();

    const bundle = new LocalCatalogSource().loadBundle(root);

    expect(Object.keys(bundle.catalog as Record<string, string>).sort()).toEqual([
      "container-only",
      "hello-world",
      "private-payload",
      "uptime-battle",
    ]);
  });

  it("should expose every existing sub-catalog projection from the abstraction", () => {
    writeRepresentativeCatalog();

    const bundle = new LocalCatalogSource().loadBundle(root);

    // Each projection the backend stacks consume must be present.
    expect(bundle).toHaveProperty("catalog");
    expect(bundle).toHaveProperty("scoring");
    expect(bundle).toHaveProperty("writeups");
    expect(bundle).toHaveProperty("endpoints");
    expect(bundle).toHaveProperty("phases");
    expect(bundle).toHaveProperty("visibility");
    expect(bundle).toHaveProperty("runtimes");
    expect(bundle).toHaveProperty("disruptions");
    expect(bundle).toHaveProperty("coordination");
    expect(bundle).toHaveProperty("coordinationBundles");
  });

  it("should bundle coordination plugins (empty when no plugins are declared)", () => {
    writeRepresentativeCatalog();

    const bundle = new LocalCatalogSource().loadBundle(root);

    expect(bundle.coordinationBundles).toEqual({});
  });

  it("should report source=core provenance for every local problem and no pack identity", () => {
    writeRepresentativeCatalog();

    const provenance = new LocalCatalogSource().describeProvenance(root);

    for (const id of ["hello-world", "private-payload", "uptime-battle", "container-only"]) {
      expect(provenance[id]).toEqual({ source: "core" });
    }
  });

  it("should return empty projections for an empty catalog without throwing", () => {
    const bundle = new LocalCatalogSource().loadBundle(root);

    expect(bundle.catalog).toEqual({});
    expect(bundle.scoring).toEqual({});
    expect(bundle.coordinationBundles).toEqual({});
    expect(new LocalCatalogSource().describeProvenance(root)).toEqual({});
  });
});

describe("SnapshotCatalogSource (#2092)", () => {
  it("should be dormant by default: core-only output equals the local bundle", () => {
    writeRepresentativeCatalog();
    const originalLoadBundle = LocalCatalogSource.prototype.loadBundle;
    let coreBundle: ReturnType<LocalCatalogSource["loadBundle"]> | undefined;
    vi.spyOn(LocalCatalogSource.prototype, "loadBundle").mockImplementation(function (
      this: LocalCatalogSource,
      problemsRoot: string,
    ) {
      const bundle = originalLoadBundle.call(this, problemsRoot);
      coreBundle = bundle;
      return bundle;
    });

    // No installed snapshots → the snapshot adapter contributes nothing.
    const snapshot = new SnapshotCatalogSource({ snapshots: [] }).loadBundle(root);

    expect(snapshot).toBe(coreBundle);
  });

  it("should leave legacy core rows untouched even when a pack adds problems", () => {
    writeRepresentativeCatalog();
    const local = new LocalCatalogSource().loadBundle(root);

    const snapshot = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Example pack",
            description: "Adds an extra problem.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
          },
          contentDigest: "a".repeat(64),
          problems: [
            {
              problemId: "pack-problem",
              directory: "problems/challenges/pack-problem",
              projections: {
                scoring: { kind: "flag", flagOutputKey: "Flag", points: 10 },
              },
            },
          ],
        },
      ],
    }).loadBundle(root);

    const localCatalog = local.catalog as Record<string, string>;
    const snapshotCatalog = snapshot.catalog as Record<string, string>;
    // Every legacy core row is byte-identical in the composed catalog.
    for (const id of Object.keys(localCatalog)) {
      expect(snapshotCatalog[id]).toBe(localCatalog[id]);
    }
    // The pack problem is additive and provenance-tagged.
    expect(snapshotCatalog["pack-problem"]).toBe("problems/challenges/pack-problem");
    const provenance = new SnapshotCatalogSource({
      snapshots: [],
    }).describeProvenance(root);
    expect(provenance["hello-world"]).toEqual({ source: "core" });
  });

  it("should keep every projection deep-equal to core when a pack declares no projections", () => {
    writeRepresentativeCatalog();
    const core = new LocalCatalogSource().loadBundle(root);

    const bundle = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.plain-pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Plain pack",
            description: "Adds a problem with no projections.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
          },
          contentDigest: "e".repeat(64),
          problems: [
            {
              problemId: "plain-pack-problem",
              directory: "pack-problems/com.example.plain-pack/1.0.0/challenges/plain",
              projections: {},
            },
          ],
        },
      ],
    }).loadBundle(root);

    expect((bundle.catalog as Record<string, string>)["plain-pack-problem"]).toBe(
      "pack-problems/com.example.plain-pack/1.0.0/challenges/plain",
    );
    expect(bundle.scoring).toEqual(core.scoring);
    expect(bundle.endpoints).toEqual(core.endpoints);
    expect(bundle.phases).toEqual(core.phases);
    expect(bundle.visibility).toEqual(core.visibility);
    expect(bundle.runtimes).toEqual(core.runtimes);
    expect(bundle.disruptions).toEqual(core.disruptions);
    expect(bundle.writeups).toEqual(core.writeups);
    expect(bundle.coordination).toEqual(core.coordination);
    expect(bundle.coordinationBundles).toEqual(core.coordinationBundles);
  });

  it("should spread a pack's parsed projection fragments into the effective bundle", () => {
    writeRepresentativeCatalog();

    const bundle = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.projection-pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Projection pack",
            description: "Exercises every supported pack projection.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [
              { provider: "aws", engine: "cloudformation" },
              { provider: "gcp", engine: "infra-manager" },
            ],
          },
          contentDigest: "f".repeat(64),
          problems: [
            {
              problemId: "pack-projection",
              directory: "pack-problems/com.example.projection-pack/1.0.0/challenges/projection",
              projections: {
                scoring: { kind: "flag", flagOutputKey: "Flag", points: 50 },
                endpoints: [
                  {
                    slot: "web",
                    default: { from: "cfn-output", key: "WebUrl", appendPath: "/health" },
                    overridable: false,
                  },
                ],
                phases: [{ name: "attack", afterMinutes: 10 }],
                runtimes: { provider: "gcp", engine: "infra-manager", entry: "main.yaml" },
                disruptions: [{ id: "latency", name: "Latency", eventDetailType: "Latency" }],
                writeups: { ja: "解説", en: "Writeup" },
                coordination: { plugin: "coordination/router.ts" },
                coordinationBundle: "export default {};",
              },
            },
          ],
        },
      ],
      platform: {
        availableRuntimes: [
          { provider: "aws", engine: "cloudformation" },
          { provider: "gcp", engine: "infra-manager" },
        ],
      },
    }).loadBundle(root);

    expect((bundle.scoring as Record<string, unknown>)["pack-projection"]).toEqual({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 50,
    });
    expect((bundle.endpoints as Record<string, unknown>)["pack-projection"]).toEqual([
      {
        slot: "web",
        default: { from: "cfn-output", key: "WebUrl", appendPath: "/health" },
        overridable: false,
      },
    ]);
    expect((bundle.phases as Record<string, unknown>)["pack-projection"]).toEqual([
      { name: "attack", afterMinutes: 10 },
    ]);
    expect((bundle.runtimes as Record<string, unknown>)["pack-projection"]).toEqual({
      provider: "gcp",
      engine: "infra-manager",
      entry: "main.yaml",
    });
    expect((bundle.disruptions as Record<string, unknown>)["pack-projection"]).toEqual([
      { id: "latency", name: "Latency", eventDetailType: "Latency" },
    ]);
    expect((bundle.writeups as Record<string, unknown>)["pack-projection"]).toEqual({
      ja: "解説",
      en: "Writeup",
    });
    expect((bundle.coordination as Record<string, unknown>)["pack-projection"]).toEqual({
      plugin: "coordination/router.ts",
    });
    expect((bundle.coordinationBundles as Record<string, string>)["pack-projection"]).toBe(
      "export default {};",
    );
  });

  it("should fail loud when a pack projection declares private visibility", () => {
    writeRepresentativeCatalog();

    const source = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.private-pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Private pack",
            description: "Should fail because ADR-008 presigned payloads are unavailable.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
          },
          contentDigest: "a".repeat(64),
          problems: [
            {
              problemId: "pack-private",
              directory: "pack-problems/com.example.private-pack/1.0.0/challenges/private",
              projections: { visibility: "private" },
            },
          ],
        },
      ],
    });

    expect(() => source.loadBundle(root)).toThrow(
      /packId='com\.example\.private-pack'.*problemId='pack-private'.*ADR-008 presigned/,
    );
  });

  it("should fail closed when a pack problem id duplicates a core id", () => {
    writeRepresentativeCatalog();

    const source = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Clashing pack",
            description: "Declares an existing core id.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
          },
          contentDigest: "b".repeat(64),
          problems: [
            { problemId: "hello-world", directory: "problems/challenges/x", projections: {} },
          ],
        },
      ],
    });

    expect(() => source.loadBundle(root)).toThrow(/hello-world/);
  });

  it("should be inert: composing with no snapshots leaves the default path byte-identical", () => {
    // The whole point of #2092: the snapshot adapter exists but is NOT activated.
    // The local adapter is the default; the snapshot adapter with no packs must
    // produce a bundle deeply equal to the local one (proving zero default drift).
    writeRepresentativeCatalog();

    const local = new LocalCatalogSource().loadBundle(root);
    const snapshot = new SnapshotCatalogSource({ snapshots: [] }).loadBundle(root);

    expect(snapshot).toEqual(local);
  });
});

/**
 * [#2323] Coordination ACTIVATION through the snapshot adapter.
 *
 * ADR-028 packs may declare `interTeamCoordination.plugin`. Before #2323 the snapshot
 * adapter propagated only the pack's catalog directory map, so an installed coordination
 * pack was inert — its `coordination` / `coordinationBundles` projections never reached the
 * effective bundle (and therefore never reached the dispatcher). These tests pin that a pack
 * whose problem carries a `coordination` projection + a bundled `.mjs` now flows both onto the
 * bundle, while a core-only / non-coordination load stays byte-identical (NO-OP) and the
 * compose fail-closed guarantees (duplicate id / unavailable runtime) still throw.
 */
const COORDINATION_BUNDLE_MJS = "export default { reduce: (state) => state };";

function coordinationPackSnapshot(options?: { readonly withBundle?: boolean }) {
  const withBundle = options?.withBundle ?? true;
  return {
    manifest: {
      schemaVersion: 1 as const,
      id: "com.example.coordination-pack",
      version: "1.0.0",
      core: "^1.0.0",
      title: "Coordination pack",
      description: "Declares an inter-team coordination plugin (ADR-028).",
      license: "Apache-2.0",
      problemsRoot: "problems",
      requiredRuntimes: [{ provider: "aws" as const, engine: "cloudformation" as const }],
    },
    contentDigest: "c".repeat(64),
    problems: [
      {
        problemId: "sector-control",
        directory: "problems/battles/sector-control",
        projections: {
          coordination: { plugin: "coordination/sector-control.ts" },
          ...(withBundle ? { coordinationBundle: COORDINATION_BUNDLE_MJS } : {}),
        },
      },
    ],
  };
}

describe("SnapshotCatalogSource coordination activation (#2323)", () => {
  it("should propagate a pack's coordination plugin and bundle into the effective bundle", () => {
    writeRepresentativeCatalog();

    const bundle = new SnapshotCatalogSource({
      snapshots: [coordinationPackSnapshot()],
    }).loadBundle(root);

    // The pack's coordination declaration reaches `coordination` (→ dispatcher scope resolver).
    expect((bundle.coordination as Record<string, unknown>)["sector-control"]).toEqual({
      plugin: "coordination/sector-control.ts",
    });
    // The synth-bundled `.mjs` reaches `coordinationBundles` (→ CoordinationPluginBundle S3).
    expect((bundle.coordinationBundles as Record<string, string>)["sector-control"]).toBe(
      COORDINATION_BUNDLE_MJS,
    );
    // The pack problem is also additive in the catalog directory map (unchanged behavior).
    expect((bundle.catalog as Record<string, string>)["sector-control"]).toBe(
      "problems/battles/sector-control",
    );
  });

  it("should keep core coordination byte-identical when no pack declares coordination", () => {
    writeRepresentativeCatalog();
    const core = new LocalCatalogSource().loadBundle(root);

    // A pack that adds a NON-coordination problem must not perturb the coordination maps.
    const bundle = new SnapshotCatalogSource({
      snapshots: [
        {
          manifest: {
            schemaVersion: 1,
            id: "com.example.plain-pack",
            version: "1.0.0",
            core: "^1.0.0",
            title: "Plain pack",
            description: "Adds a problem with no coordination.",
            license: "Apache-2.0",
            problemsRoot: "problems",
            requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
          },
          contentDigest: "d".repeat(64),
          problems: [
            { problemId: "plain", directory: "problems/challenges/plain", projections: {} },
          ],
        },
      ],
    }).loadBundle(root);

    expect(bundle.coordination).toEqual(core.coordination);
    expect(bundle.coordinationBundles).toEqual(core.coordinationBundles);
  });

  it("should carry the plugin declaration even when the pack ships no bundle", () => {
    writeRepresentativeCatalog();

    const bundle = new SnapshotCatalogSource({
      snapshots: [coordinationPackSnapshot({ withBundle: false })],
    }).loadBundle(root);

    // Declaration flows; the (absent) bundle simply contributes no `coordinationBundles` key.
    expect((bundle.coordination as Record<string, unknown>)["sector-control"]).toEqual({
      plugin: "coordination/sector-control.ts",
    });
    expect(bundle.coordinationBundles).toEqual({});
  });

  it("should fail closed when a coordination pack's required runtime is unavailable", () => {
    writeRepresentativeCatalog();

    const source = new SnapshotCatalogSource({
      snapshots: [coordinationPackSnapshot()],
      // Platform offers no runtime, so the pack's aws/cloudformation requirement is unmet.
      platform: { availableRuntimes: [] },
    });

    expect(() => source.loadBundle(root)).toThrow(/RUNTIME_UNAVAILABLE/);
  });
});
