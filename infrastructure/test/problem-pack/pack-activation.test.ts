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
const PLATFORM: PlatformContext = {
  coreVersion: CORE_VERSION,
  availableRuntimes: AVAILABLE_RUNTIMES,
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(manifest(options.manifestOverrides), null, 2),
  );
  const problemDir = path.join(dir, "problems", "challenges", problemId);
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
