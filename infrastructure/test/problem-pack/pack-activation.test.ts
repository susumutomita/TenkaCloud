/**
 * [Problem Packs / Issue #2095] Tests for per-tenant activation + event pinning.
 *
 * These exercise the REAL engine over temp directories on the actual filesystem
 * (no FS mocks): packs are genuinely installed (#2094) and then activated /
 * deactivated, the tenant effective catalog is composed, an event pins a catalog
 * snapshot, and deployments resolve provenance from that pin. `installedAt` /
 * `coreVersion` and the platform context are INJECTED so the suite is
 * deterministic. No network, no CDK synth.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProblemsCatalogBundle } from "../../lib/app-config/types";
import type { CoreProblemInput, PlatformContext } from "../../lib/problem-pack/effective-catalog";
import {
  createEventSnapshot,
  EventSnapshotStore,
  resolveDeploymentProvenance,
} from "../../lib/problem-pack/event-pin";
import { installPack } from "../../lib/problem-pack/lifecycle";
import {
  ActivationStore,
  composeTenantEffectiveCatalog,
  tenantCatalogSource,
} from "../../lib/problem-pack/pack-activation";

let base: string;
let storeDir: string;

const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "1.0.0";
const AVAILABLE_RUNTIMES = [{ provider: "aws", engine: "cloudformation" }] as const;
const PROJECTION_AVAILABLE_RUNTIMES = [
  { provider: "aws", engine: "cloudformation" },
  { provider: "gcp", engine: "infra-manager" },
] as const;
const PLATFORM: PlatformContext = {
  coreVersion: CORE_VERSION,
  availableRuntimes: AVAILABLE_RUNTIMES,
};
const PROJECTION_PLATFORM: PlatformContext = {
  coreVersion: CORE_VERSION,
  availableRuntimes: PROJECTION_AVAILABLE_RUNTIMES,
};

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-activation-"));
  storeDir = path.join(base, "store");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.example.cloud-pack",
    version: "1.0.0",
    core: "^1.0.0",
    title: "Example Cloud Pack",
    description: "A sample pack of cloud problems.",
    license: "Apache-2.0",
    problemsRoot: "problems",
    requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    ...overrides,
  };
}

function awsProblem(id: string): Record<string, unknown> {
  return {
    id,
    title: id,
    category: "challenges",
    cfnTemplate: "template.yaml",
    scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
  };
}

/** Build a minimal, fully-valid pack under `dir` and return `dir`. */
function writeValidPack(
  dir: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
): string {
  const problemId = options.problemId ?? "hello-world";
  const packManifest = manifest(options.manifestOverrides);
  const problemsRoot =
    typeof packManifest.problemsRoot === "string" ? packManifest.problemsRoot : "problems";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tenkacloud-pack.json"), JSON.stringify(packManifest, null, 2));
  const problemDir = path.join(dir, problemsRoot, "challenges", problemId);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify(awsProblem(problemId), null, 2),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "# CFn deploy body\nResources: {}\n");
  return dir;
}

/** Install a pack from a fresh source dir and return its lock entry. */
function installPackFrom(
  name: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
) {
  const sourceDir = path.join(base, name);
  writeValidPack(sourceDir, options);
  const result = installPack({
    sourceDir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: AVAILABLE_RUNTIMES,
  });
  if (!result.ok) throw new Error(`install failed: ${result.message}`);
  return result.entry;
}

const CORE: readonly CoreProblemInput[] = [
  { problemId: "core-warmup", directory: "problems/challenges/core-warmup", projections: {} },
];

/** Distinct pack id so a coordination pack coexists with the default `installPackFrom` pack. */
const COORD_PACK_ID = "com.example.coordination-pack";
const COORD_PROBLEM_ID = "coord-problem";
const COORD_PLUGIN_REL = "coordination/router.ts";
/**
 * A self-contained coordination plugin (no SDK import) so esbuild bundles it from the temp
 * snapshot dir without resolving workspace node_modules — same convention as the
 * bundle-coordination-plugins unit test.
 */
const COORD_PLUGIN_SRC =
  "const plugin = { initialState: () => ({}), validateOp: () => ({ ok: true }), applyOp: (s) => s, projectForTeam: (s) => s };\nexport default plugin;\n";

const PROJECTION_PACK_ID = "com.example.projection-pack";
const PROJECTION_PROBLEM_ID = "projection-problem";
const PROJECTION_ENDPOINT = {
  slot: "web",
  default: { from: "cfn-output", key: "WebUrl", appendPath: "/health" },
  overridable: true,
  label: "Web",
};
const PROJECTION_PHASE = { name: "attack", afterMinutes: 15, description: "Attack starts" };
const PROJECTION_DISRUPTION = {
  id: "latency",
  name: "Latency",
  eventDetailType: "ProjectionLatency",
};

/** Build a valid pack whose single problem opts into inter-team coordination. */
function writeCoordinationPack(
  dir: string,
  options: { problemId?: string; pluginSrc?: string } = {},
): string {
  const problemId = options.problemId ?? COORD_PROBLEM_ID;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(manifest({ id: COORD_PACK_ID }), null, 2),
  );
  const problemDir = path.join(dir, "problems", "challenges", problemId);
  fs.mkdirSync(path.join(problemDir, "coordination"), { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify(
      { ...awsProblem(problemId), interTeamCoordination: { plugin: COORD_PLUGIN_REL } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "# CFn deploy body\nResources: {}\n");
  fs.writeFileSync(path.join(problemDir, COORD_PLUGIN_REL), options.pluginSrc ?? COORD_PLUGIN_SRC);
  return dir;
}

/** Install a coordination pack from a fresh source dir and return its lock entry. */
function installCoordinationPackFrom(
  name: string,
  options: { problemId?: string; pluginSrc?: string } = {},
) {
  const sourceDir = path.join(base, name);
  writeCoordinationPack(sourceDir, options);
  const result = installPack({
    sourceDir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: AVAILABLE_RUNTIMES,
  });
  if (!result.ok) throw new Error(`install failed: ${result.message}`);
  return result.entry;
}

function projectionProblem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROJECTION_PROBLEM_ID,
    title: PROJECTION_PROBLEM_ID,
    category: "challenges",
    runtime: { provider: "gcp", engine: "infra-manager", entry: "main.yaml" },
    scoring: { kind: "flag", flagOutputKey: "Flag", points: 120 },
    endpoints: [PROJECTION_ENDPOINT],
    phases: [PROJECTION_PHASE],
    disruptions: [PROJECTION_DISRUPTION],
    writeup: "日本語の解説",
    i18n: { en: { writeup: "English writeup" } },
    ...overrides,
  };
}

function writeProjectionPack(
  dir: string,
  options: { metadataOverrides?: Record<string, unknown> } = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(
      manifest({
        id: PROJECTION_PACK_ID,
        requiredRuntimes: [{ provider: "gcp", engine: "infra-manager" }],
      }),
      null,
      2,
    ),
  );
  const problemDir = path.join(dir, "problems", "challenges", PROJECTION_PROBLEM_ID);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify(projectionProblem(options.metadataOverrides), null, 2),
  );
  fs.writeFileSync(path.join(problemDir, "main.yaml"), "resources: []\n");
  return dir;
}

function installProjectionPackFrom(
  name: string,
  options: { metadataOverrides?: Record<string, unknown> } = {},
) {
  const sourceDir = path.join(base, name);
  writeProjectionPack(sourceDir, options);
  const result = installPack({
    sourceDir,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: PROJECTION_AVAILABLE_RUNTIMES,
  });
  if (!result.ok) throw new Error(`install failed: ${result.message}`);
  return result.entry;
}

/** An empty local core root — the pack under test supplies the only problems. */
function emptyCoreRoot(): string {
  const dir = path.join(base, "empty-core");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ActivationStore.activate (#2095)", () => {
  it("should make an inactive pack invisible to the tenant effective catalog", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);

    // Nothing activated → the tenant sees core only.
    const composed = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });

    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entries.map((e) => e.problemId)).toEqual(["core-warmup"]);
    expect(composed.entries.some((e) => e.problemId === "pack-only")).toBe(false);
  });

  it("should make an active pack appear only for the tenant that activated it", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);

    const activated = store.activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });
    expect(activated.ok).toBe(true);

    const catalogA = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });
    const catalogB = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_B),
      platform: PLATFORM,
    });

    expect(catalogA.ok && catalogB.ok).toBe(true);
    if (!catalogA.ok || !catalogB.ok) return;
    // Tenant A sees the pack problem; tenant B does NOT (isolation).
    expect(catalogA.entries.some((e) => e.problemId === "pack-only")).toBe(true);
    expect(catalogB.entries.some((e) => e.problemId === "pack-only")).toBe(false);
    expect(catalogB.entries.map((e) => e.problemId)).toEqual(["core-warmup"]);
  });

  it("should let two tenants activate different revisions of the same pack id", () => {
    // Two revisions of the SAME pack id, each with a distinct problem id.
    installPackFrom("rev1", { manifestOverrides: { version: "1.0.0" }, problemId: "v1-problem" });
    installPackFrom("rev2", { manifestOverrides: { version: "2.0.0" }, problemId: "v2-problem" });
    const store = new ActivationStore(storeDir, PLATFORM);

    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);
    expect(
      store.activate({ tenantId: TENANT_B, packId: "com.example.cloud-pack", version: "2.0.0" }).ok,
    ).toBe(true);

    const catalogA = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });
    const catalogB = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_B),
      platform: PLATFORM,
    });

    expect(catalogA.ok && catalogB.ok).toBe(true);
    if (!catalogA.ok || !catalogB.ok) return;
    expect(catalogA.entries.some((e) => e.problemId === "v1-problem")).toBe(true);
    expect(catalogA.entries.some((e) => e.problemId === "v2-problem")).toBe(false);
    expect(catalogB.entries.some((e) => e.problemId === "v2-problem")).toBe(true);
    expect(catalogB.entries.some((e) => e.problemId === "v1-problem")).toBe(false);
  });

  it("should fail duplicate problem ids BEFORE the activation is recorded", () => {
    // A pack that re-declares a CORE problem id. It installs fine (install does not
    // consider core), but activating it for a tenant whose effective catalog
    // already has that core id must fail closed — packs cannot override core.
    installPackFrom("pack-a", { problemId: "core-warmup" });
    const store = new ActivationStore(storeDir, {
      platform: PLATFORM,
      coreProblemIds: ["core-warmup"],
    });

    const clash = store.activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.reason).toBe("DUPLICATE_PROBLEM_ID");
    // The clashing activation must NOT have persisted.
    expect(store.listForTenant(TENANT_A)).toEqual([]);
  });

  it("should refuse to activate a revision that is not installed", () => {
    const store = new ActivationStore(storeDir, PLATFORM);

    const result = store.activate({
      tenantId: TENANT_A,
      packId: "com.example.missing",
      version: "9.9.9",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_INSTALLED");
  });

  it("should refuse a digest that disagrees with the installed immutable revision", () => {
    const entry = installPackFrom("pack-a");
    const store = new ActivationStore(storeDir, PLATFORM);

    const result = store.activate({
      tenantId: TENANT_A,
      packId: entry.packId,
      version: entry.version,
      contentDigest: "deadbeef-not-the-real-digest",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DIGEST_MISMATCH");
  });

  it("should be idempotent when the same revision is activated twice for a tenant", () => {
    installPackFrom("pack-a");
    const store = new ActivationStore(storeDir, PLATFORM);

    const first = store.activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });
    const second = store.activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.alreadyActive).toBe(false);
    expect(second.alreadyActive).toBe(true);
    expect(store.listForTenant(TENANT_A)).toHaveLength(1);
  });
});

describe("ActivationStore.deactivate (#2095)", () => {
  it("should remove a tenant's active revision", () => {
    installPackFrom("pack-a");
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const result = store.deactivate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    expect(result.ok).toBe(true);
    expect(store.listForTenant(TENANT_A)).toEqual([]);
  });

  it("should report NOT_ACTIVE when deactivating a revision that was never active", () => {
    installPackFrom("pack-a");
    const store = new ActivationStore(storeDir, PLATFORM);

    const result = store.deactivate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_ACTIVE");
  });
});

/**
 * [Problem Packs / Issue #2459] `ActivationStore.list()` is the cross-tenant read the SaaS-mode
 * synth guard (`lib/problem-pack/saas-pack-guard.ts`) depends on — it must see every tenant's
 * activations, not just one, so a pack activated for ANY tenant is caught before a SaaS synth
 * would silently ignore it.
 */
describe("ActivationStore.list (#2459)", () => {
  it("should return an empty array when no activations exist", () => {
    installPackFrom("pack-a");
    const store = new ActivationStore(storeDir, PLATFORM);

    expect(store.list()).toEqual([]);
  });

  it("should return activations across all tenants, not just one", () => {
    installPackFrom("pack-a", { problemId: "problem-a" });
    installPackFrom("pack-b", {
      manifestOverrides: { id: "com.example.other-pack", version: "2.0.0" },
      problemId: "problem-b",
    });
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });
    store.activate({ tenantId: TENANT_B, packId: "com.example.other-pack", version: "2.0.0" });

    const all = store.list();

    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: TENANT_A, packId: "com.example.cloud-pack" }),
        expect.objectContaining({ tenantId: TENANT_B, packId: "com.example.other-pack" }),
      ]),
    );
  });
});

describe("createEventSnapshot + EventSnapshotStore (#2095)", () => {
  it("should keep an event pinned after the pack is deactivated", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const events = new EventSnapshotStore(storeDir);
    const created = createEventSnapshot({
      eventId: "evt-1",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.put(created.snapshot);
    const pinnedBefore = events.get("evt-1");
    expect(pinnedBefore?.problems.some((p) => p.problemId === "pack-only")).toBe(true);

    // Deactivate the pack AFTER the event is created.
    store.deactivate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    // The event's pinned catalog is unchanged — the pack problem is still pinned.
    const pinnedAfter = events.get("evt-1");
    expect(pinnedAfter).toEqual(pinnedBefore);
    expect(pinnedAfter?.problems.some((p) => p.problemId === "pack-only")).toBe(true);
    // But the LIVE tenant catalog no longer contains it.
    const live = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.entries.some((e) => e.problemId === "pack-only")).toBe(false);
  });

  it("should fail event creation on an incompatible required runtime", () => {
    // A normal AWS pack (requires aws/cloudformation), activated against the AWS
    // platform, then pinned against a platform that offers NO runtimes — so the
    // pack's required runtime is unavailable and event creation fails closed.
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const runtimeless: PlatformContext = { coreVersion: CORE_VERSION, availableRuntimes: [] };
    const created = createEventSnapshot({
      eventId: "evt-runtime",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_A),
      platform: runtimeless,
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("RUNTIME_UNAVAILABLE");
  });

  it("should fail event creation on a duplicate problem id across core and a pack", () => {
    // A pack that re-declares a core problem id.
    installPackFrom("pack-a", { problemId: "core-warmup" });
    const permissive = new ActivationStore(storeDir, PLATFORM);
    permissive.activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    const created = createEventSnapshot({
      eventId: "evt-dup",
      tenantId: TENANT_A,
      core: CORE, // already has "core-warmup"
      activePacks: permissive.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("DUPLICATE_PROBLEM_ID");
  });

  it("should refuse to overwrite an already-pinned event id", () => {
    const events = new EventSnapshotStore(storeDir);
    const first = createEventSnapshot({
      eventId: "evt-1",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: [],
      platform: PLATFORM,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    events.put(first.snapshot);

    expect(() => events.put(first.snapshot)).toThrow(/immutable/i);
  });

  it("should produce a deterministic catalog snapshot id for equal pins", () => {
    const a = createEventSnapshot({
      eventId: "evt-1",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: [],
      platform: PLATFORM,
    });
    const b = createEventSnapshot({
      eventId: "evt-1",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: [],
      platform: PLATFORM,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.snapshot.catalogSnapshotId).toBe(b.snapshot.catalogSnapshotId);
  });
});

describe("resolveDeploymentProvenance (#2095)", () => {
  it("should resolve a deployment's provenance from its event snapshot, not the live catalog", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const entry = new ActivationStore(storeDir, PLATFORM);
    entry.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const created = createEventSnapshot({
      eventId: "evt-1",
      tenantId: TENANT_A,
      core: CORE,
      activePacks: entry.snapshotInputsForTenant(TENANT_A),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Deactivate AFTER pinning — provenance must still resolve from the snapshot.
    entry.deactivate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const provenance = resolveDeploymentProvenance(created.snapshot, "pack-only");
    expect(provenance).toBeDefined();
    expect(provenance?.source).toBe("pack");
    if (provenance?.source === "pack") {
      expect(provenance.packId).toBe("com.example.cloud-pack");
      expect(provenance.packVersion).toBe("1.0.0");
    }

    const coreProvenance = resolveDeploymentProvenance(created.snapshot, "core-warmup");
    expect(coreProvenance?.source).toBe("core");

    // A problem id not in the pin resolves to undefined (fail closed).
    expect(resolveDeploymentProvenance(created.snapshot, "never-pinned")).toBeUndefined();
  });
});

describe("core-only tenant regression (#2095)", () => {
  it("should leave a tenant with no activations seeing exactly the core catalog", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);

    const composed = composeTenantEffectiveCatalog({
      core: CORE,
      activePacks: store.snapshotInputsForTenant("untouched-tenant"),
      platform: PLATFORM,
    });

    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entries.map((e) => e.problemId)).toEqual(["core-warmup"]);
    expect(composed.entries[0].provenance.source).toBe("core");
  });

  it("should give a core-only tenant a catalog source byte-identical to the local source", () => {
    const store = new ActivationStore(storeDir, PLATFORM);
    const source = tenantCatalogSource(store, "core-only-tenant", PLATFORM);
    // With no installed/active snapshots the source composes core only; the
    // describeProvenance of a fresh real problems root is all `core`.
    const provenance = source.describeProvenance(
      path.resolve(import.meta.dirname, "..", "..", "..", "problems"),
    );
    for (const value of Object.values(provenance)) {
      expect(value.source).toBe("core");
    }
  });
});

describe("ActivationStore snapshot directory keys (#2462)", () => {
  it("should key each active pack problem by pack id, version, and relative problem directory", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);

    const inputs = store.snapshotInputsForTenant(TENANT_A);

    expect(inputs[0]?.problems).toEqual([
      {
        problemId: "pack-only",
        directory: "pack-problems/com.example.cloud-pack/1.0.0/challenges/pack-only",
        projections: {},
      },
    ]);
  });

  it("should strip a custom problemsRoot when building the per-problem directory key", () => {
    installPackFrom("custom-root-pack", {
      manifestOverrides: { problemsRoot: "catalog/problems" },
      problemId: "root-stripped",
    });
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);

    const inputs = store.snapshotInputsForTenant(TENANT_A);

    expect(inputs[0]?.problems[0]?.directory).toBe(
      "pack-problems/com.example.cloud-pack/1.0.0/challenges/root-stripped",
    );
  });

  it("should expose the on-disk pack assets a tenant's active revisions materialize from", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);

    const assets = store.packAssetsForTenant(TENANT_A);

    expect(assets).toHaveLength(1);
    expect(assets[0]?.packId).toBe("com.example.cloud-pack");
    expect(assets[0]?.version).toBe("1.0.0");
    // problemsRootAbs must point at the snapshot's problems root, so the pack's deploy body is
    // actually reachable for the BucketDeployment (this is what makes deploy work, not 404).
    expect(
      fs.existsSync(
        path.join(assets[0]?.problemsRootAbs ?? "", "challenges", "pack-only", "template.yaml"),
      ),
    ).toBe(true);
  });

  it("should point pack assets at a custom problemsRoot subdirectory of the snapshot", () => {
    installPackFrom("custom-root-pack", {
      manifestOverrides: { problemsRoot: "catalog/problems" },
      problemId: "root-stripped",
    });
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);

    const assets = store.packAssetsForTenant(TENANT_A);

    expect(assets[0]?.problemsRootAbs.endsWith(path.join("catalog", "problems"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(assets[0]?.problemsRootAbs ?? "", "challenges", "root-stripped", "template.yaml"),
      ),
    ).toBe(true);
  });

  it("should return no pack assets for a tenant with no active revisions", () => {
    installPackFrom("pack-a", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" }).ok,
    ).toBe(true);

    // A different tenant activated nothing → no assets (its Lite synth stays core-only).
    expect(store.packAssetsForTenant(TENANT_B)).toEqual([]);
  });
});

/**
 * Issue #2323: Installed-snapshot coordination activation.
 *
 * PR #2328 taught `SnapshotCatalogSource.loadBundle` to read a pack's
 * `coordination` / `coordinationBundle` back off `projections`, but the production
 * installed-snapshot path (`ActivationStore.loadSnapshotInput`) still handed it `projections: {}`,
 * so an installed + active coordination pack stayed inert. These tests pin that
 * `tenantCatalogSource` (the deploy / synth path) now discovers the pack's
 * `interTeamCoordination.plugin` from the immutable snapshot dir and synth-bundles it onto the
 * effective bundle, while every other path (activate() dry-run, event-pin via the default
 * `snapshotInputsForTenant`) stays byte-identical (`projections: {}`, no esbuild, never throws).
 */
describe("ActivationStore coordination activation (#2323)", () => {
  it("should carry an installed pack's coordination plugin + bundle onto the effective bundle via tenantCatalogSource", () => {
    installCoordinationPackFrom("coord-pack");
    const store = new ActivationStore(storeDir, PLATFORM);
    expect(store.activate({ tenantId: TENANT_A, packId: COORD_PACK_ID, version: "1.0.0" }).ok).toBe(
      true,
    );

    const bundle = tenantCatalogSource(store, TENANT_A, PLATFORM).loadBundle(
      emptyCoreRoot(),
    ) as ProblemsCatalogBundle;

    // The pack's declaration reaches `coordination` (→ dispatcher scope resolver) ...
    expect((bundle.coordination as Record<string, unknown>)[COORD_PROBLEM_ID]).toEqual({
      plugin: COORD_PLUGIN_REL,
    });
    // ... and the synth-bundled `.mjs` reaches `coordinationBundles` (→ CoordinationPluginBundle S3).
    const bundles = bundle.coordinationBundles as Record<string, string>;
    expect(bundles[COORD_PROBLEM_ID]).toContain("validateOp");
  });

  it("should keep snapshotInputsForTenant byte-identical unless coordination activation is requested", () => {
    installCoordinationPackFrom("coord-pack");
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: COORD_PACK_ID, version: "1.0.0" });

    // Default (event-pin path): projections stay empty — no scoring/coordination, no esbuild.
    const defaultInputs = store.snapshotInputsForTenant(TENANT_A);
    expect(defaultInputs[0].problems[0].projections).toEqual({});

    // Opt-in (deploy path): the core extractors populate scoring, and coordination is bundled.
    const activated = store.snapshotInputsForTenant(TENANT_A, { withCoordinationProjection: true });
    expect(activated[0].problems[0].projections).toMatchObject({
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
      coordination: { plugin: COORD_PLUGIN_REL },
    });
  });

  it("should leave coordination maps empty when a pack declares no coordination on the deploy path", () => {
    // A normal (non-coordination) pack must contribute no coordination keys even though
    // #2463 now projects scoring and the other non-coordination metadata.
    installPackFrom("plain-pack", { problemId: "pack-only" });
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });

    const bundle = tenantCatalogSource(store, TENANT_A, PLATFORM).loadBundle(
      emptyCoreRoot(),
    ) as ProblemsCatalogBundle;

    expect(bundle.coordination).toEqual({});
    expect(bundle.coordinationBundles).toEqual({});
    const inputs = store.snapshotInputsForTenant(TENANT_A, { withCoordinationProjection: true });
    expect(inputs[0].problems[0].projections).toMatchObject({
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    });
    expect(inputs[0].problems[0].projections).not.toHaveProperty("coordination");
  });

  it("should still let a coordination pack activate without bundling (dry-run never throws)", () => {
    // A coordination pack whose plugin CANNOT be bundled still installs + activates: the dry-run
    // compose never bundles, so activate() keeps its "never throws" contract.
    installCoordinationPackFrom("broken-pack", { pluginSrc: "export default (;\n" });
    const store = new ActivationStore(storeDir, PLATFORM);

    const activated = store.activate({
      tenantId: TENANT_A,
      packId: COORD_PACK_ID,
      version: "1.0.0",
    });
    expect(activated.ok).toBe(true);
  });

  it("should fail loud at synth when a coordination pack's plugin cannot be bundled", () => {
    // The deploy path must not silently drop a broken plugin: tenantCatalogSource eagerly resolves
    // + synth-bundles the active snapshots, so esbuild throws loud (no silent fallback).
    installCoordinationPackFrom("broken-pack", { pluginSrc: "export default (;\n" });
    const store = new ActivationStore(storeDir, PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: COORD_PACK_ID, version: "1.0.0" });

    expect(() => tenantCatalogSource(store, TENANT_A, PLATFORM)).toThrow();
  });
});

describe("ActivationStore pack projection activation (#2463)", () => {
  it("should carry installed pack scoring/endpoints/phases/runtimes/disruptions/writeups via tenantCatalogSource", () => {
    installProjectionPackFrom("projection-pack");
    const store = new ActivationStore(storeDir, PROJECTION_PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: PROJECTION_PACK_ID, version: "1.0.0" }).ok,
    ).toBe(true);

    const bundle = tenantCatalogSource(store, TENANT_A, PROJECTION_PLATFORM).loadBundle(
      emptyCoreRoot(),
    ) as ProblemsCatalogBundle;

    expect((bundle.catalog as Record<string, string>)[PROJECTION_PROBLEM_ID]).toBe(
      `pack-problems/${PROJECTION_PACK_ID}/1.0.0/challenges/${PROJECTION_PROBLEM_ID}`,
    );
    expect((bundle.scoring as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 120,
    });
    expect((bundle.endpoints as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual([
      PROJECTION_ENDPOINT,
    ]);
    expect((bundle.phases as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual([
      PROJECTION_PHASE,
    ]);
    expect((bundle.runtimes as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual({
      provider: "gcp",
      engine: "infra-manager",
      entry: "main.yaml",
    });
    expect((bundle.disruptions as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual([
      PROJECTION_DISRUPTION,
    ]);
    expect((bundle.writeups as Record<string, unknown>)[PROJECTION_PROBLEM_ID]).toEqual({
      ja: "日本語の解説",
      en: "English writeup",
    });
    // `visibility: public` is omitted by the core extractor, so the pack contributes no
    // visibility row unless it declares private visibility, which is rejected below.
    expect(bundle.visibility).toEqual({});
  });

  it("should keep default snapshot inputs projection-free for event pinning", () => {
    installProjectionPackFrom("projection-pack");
    const store = new ActivationStore(storeDir, PROJECTION_PLATFORM);
    store.activate({ tenantId: TENANT_A, packId: PROJECTION_PACK_ID, version: "1.0.0" });

    expect(store.snapshotInputsForTenant(TENANT_A)[0].problems[0].projections).toEqual({});
  });

  it("should fail loud at synth when an active pack declares private visibility", () => {
    installProjectionPackFrom("private-pack", { metadataOverrides: { visibility: "private" } });
    const store = new ActivationStore(storeDir, PROJECTION_PLATFORM);
    expect(
      store.activate({ tenantId: TENANT_A, packId: PROJECTION_PACK_ID, version: "1.0.0" }).ok,
    ).toBe(true);

    expect(() => tenantCatalogSource(store, TENANT_A, PROJECTION_PLATFORM)).toThrow(
      /packId='com\.example\.projection-pack'.*problemId='projection-problem'.*presigned private-payload/,
    );
  });
});
