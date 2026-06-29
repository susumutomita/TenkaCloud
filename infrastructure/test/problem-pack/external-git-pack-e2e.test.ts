/**
 * [Problem Packs / Issue #2098] End-to-end acceptance: an external Git pack from
 * authoring through event deployment.
 *
 * This suite proves the FULL external-Git-pack lifecycle the issue describes,
 * DETERMINISTICALLY and OFFLINE. It stitches together the real modules shipped in
 * the dependency chain — #2089 scaffolder, #2106 `@tenkacloud/problem-sdk`
 * validator, #2097 pinned-Git install, #2095 activation + immutable event pin —
 * with NO network, NO real cloud, and NO real Git network. Every external boundary
 * that would touch the world is replaced by a deterministic INJECTED fake:
 *
 *   - the Git transport is the injected {@link GitArchiveFetcher} that serves a
 *     LOCAL fixture pack pinned to a full 40-hex SHA (no `git` process is spawned);
 *   - the clock (`installedAt`) and the platform/core version are injected;
 *   - the pack itself is authored into an ISOLATED fixture directory that lives
 *     OUTSIDE the core `problems/` tree, so no core problem is ever touched.
 *
 * The flow asserted here mirrors the issue's required steps:
 *   1. scaffold a pack (real #2089 scaffolder) into an isolated fixture repo;
 *   2. validate it OUTSIDE the core repo with the public SDK validator (#2106);
 *   3. serve a pinned Git revision (full SHA) via the injected fetcher;
 *   4. install the EXACT revision (#2097) — lock records sourceKind "git" + the
 *      content digest + the resolved commit;
 *   5. activate it for ONE tenant (#2095);
 *   6. verify it is ABSENT for another tenant (isolation);
 *   7. create an event selecting its problem — the catalog snapshot is pinned;
 *   8. verify the deployment resolves provenance from the EVENT pin;
 *   9. deactivate / install a newer revision;
 *  10. verify the existing event's pin is UNCHANGED (immutability);
 *  11. remove is BLOCKED while pinned and ALLOWED after references are removed.
 *
 * The companion manual runbook for a SEPARATE REAL repository (the only part that
 * cannot run offline) is documented in
 * `infrastructure/lib/problem-pack/README-external-git-pack.md`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePackDirectory } from "@tenkacloud/problem-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreProblemInput, PlatformContext } from "../../lib/problem-pack/effective-catalog";
import {
  createEventSnapshot,
  EventSnapshotStore,
  resolveDeploymentProvenance,
} from "../../lib/problem-pack/event-pin";
import type { GitArchiveFetcher } from "../../lib/problem-pack/git-source";
import { installGitPack } from "../../lib/problem-pack/git-source";
import { buildPackScaffold } from "../../lib/problem-pack/init-pack";
import { removePack } from "../../lib/problem-pack/lifecycle";
import { ActivationStore } from "../../lib/problem-pack/pack-activation";
import { type PackLockEntry, readLock } from "../../lib/problem-pack/snapshot";

// ── Injected determinism (clock / version / platform / ids) ──────────────────
const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "1.0.0";
const AVAILABLE_RUNTIMES = [{ provider: "aws", engine: "cloudformation" }] as const;
const PLATFORM: PlatformContext = {
  coreVersion: CORE_VERSION,
  availableRuntimes: AVAILABLE_RUNTIMES,
};

// Two distinct, immutable full 40-hex commits for revision v1 and revision v2.
const COMMIT_V1 = "1111111111111111111111111111111111111111";
const COMMIT_V2 = "2222222222222222222222222222222222222222";
const REPO_URL = "https://github.com/example/external-cloud-pack.git";

const PACK_ID = "com.example.external-pack";
const TENANT_HOST = "tenant-host"; // the tenant that activates the pack
const TENANT_GUEST = "tenant-guest"; // a second tenant that must NOT see it
const EVENT_ID = "evt-regional-final";

// A single core problem every tenant always sees, so core-only isolation is testable.
const CORE: readonly CoreProblemInput[] = [
  { problemId: "core-warmup", directory: "problems/challenges/core-warmup", projections: {} },
];

let base: string;
let storeDir: string;
let authorDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-git-pack-e2e-"));
  storeDir = path.join(base, "store");
  // The authored pack lives OUTSIDE the core repo's problems/ tree, in a fixture
  // dir the test owns — proving step "no core problems/ edit is required".
  authorDir = path.join(base, "fixture-repo", "external-pack");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * Author a pack into `dir` using the REAL #2089 scaffolder, then overlay a
 * caller-chosen version and a single problem id so each revision is a distinct,
 * validator-passing pack. The scaffolder is the source of truth for the baseline
 * layout; we only edit the manifest fields the e2e varies.
 */
function authorPack(dir: string, options: { version: string; problemId: string }): void {
  // 1. Real scaffolder → deterministic, validator-passing baseline files.
  const files = buildPackScaffold({ packId: PACK_ID, runtime: "aws/cloudformation" });
  for (const [rel, content] of files) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // 2. Stamp the manifest version (a new version is a new immutable revision).
  const manifestPath = path.join(dir, "tenkacloud-pack.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  manifest.version = options.version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // 3. Rename the scaffold's single problem to the caller's problem id so each
  //    revision contributes a distinct problem id (no cross-revision clash).
  const problemsRoot = path.join(dir, "problems", "challenges");
  fs.renameSync(path.join(problemsRoot, "hello-world"), path.join(problemsRoot, options.problemId));
  const metaPath = path.join(problemsRoot, options.problemId, "metadata.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.id = options.problemId;
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * An injected Git transport that serves a LOCAL fixture pack instead of cloning a
 * remote. It copies `sourceDir`'s contents into the install's temporary directory,
 * exactly as the real fetcher promotes a checked-out pack root. It records the
 * requests it received so the e2e can assert the pinned commit was forwarded.
 */
function fixtureFetcher(sourceDir: string): GitArchiveFetcher & {
  requests: Array<{ commit: string; repositoryUrl: string; subdir: string }>;
} {
  const requests: Array<{ commit: string; repositoryUrl: string; subdir: string }> = [];
  const fetcher: GitArchiveFetcher = (request) => {
    requests.push({
      commit: request.commit,
      repositoryUrl: request.repositoryUrl,
      subdir: request.subdir,
    });
    fs.cpSync(sourceDir, request.destinationDir, { recursive: true });
  };
  return Object.assign(fetcher, { requests });
}

function installRevision(sourceDir: string, commit: string) {
  return installGitPack({
    url: REPO_URL,
    commit,
    storeDir,
    installedAt: INSTALLED_AT,
    coreVersion: CORE_VERSION,
    availableRuntimes: AVAILABLE_RUNTIMES,
    fetcher: fixtureFetcher(sourceDir),
  });
}

function newActivationStore(): ActivationStore {
  return new ActivationStore(storeDir, { platform: PLATFORM, coreProblemIds: ["core-warmup"] });
}

describe("external Git pack e2e: authoring -> install -> activate -> event -> deploy (#2098)", () => {
  it("should author a scaffolded pack OUTSIDE the core problems/ tree", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });

    // The pack lives in the isolated fixture repo, not under the core problems/.
    expect(fs.existsSync(path.join(authorDir, "tenkacloud-pack.json"))).toBe(true);
    const coreProblemsRoot = path.resolve(import.meta.dirname, "..", "..", "..", "problems");
    expect(authorDir.startsWith(coreProblemsRoot)).toBe(false);
  });

  it("should validate the authored pack OUTSIDE the core repo with the public SDK validator", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });

    // Stage 2: the public #2106 SDK validator passes with zero diagnostics.
    const validation = validatePackDirectory(authorDir);
    expect(validation.ok).toBe(true);
    expect(validation.diagnostics).toEqual([]);
    expect(validation.manifest?.id).toBe(PACK_ID);
    expect(validation.problemIds).toEqual(["regional-network"]);
  });

  it("should install the EXACT pinned revision and record git provenance + digest in the lock", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });

    // Stage 3+4: serve a pinned full-SHA revision and install exactly it.
    const fetcher = fixtureFetcher(authorDir);
    const result = installGitPack({
      url: REPO_URL,
      commit: COMMIT_V1,
      storeDir,
      installedAt: INSTALLED_AT,
      coreVersion: CORE_VERSION,
      availableRuntimes: AVAILABLE_RUNTIMES,
      fetcher,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The lock pins git provenance: sourceKind "git", the resolved commit, digest.
    expect(result.entry.sourceKind).toBe("git");
    expect(result.entry.git).toEqual({ repositoryUrl: REPO_URL, commit: COMMIT_V1, subdir: "" });
    expect(result.entry.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.problemCount).toBe(1);
    // The fetcher was handed the exact pinned commit (no floating ref).
    expect(fetcher.requests).toEqual([{ commit: COMMIT_V1, repositoryUrl: REPO_URL, subdir: "" }]);

    const lock = readLock(storeDir);
    expect(lock.packs).toHaveLength(1);
    expect(lock.packs[0].sourceKind).toBe("git");
    expect(lock.packs[0].git?.commit).toBe(COMMIT_V1);
  });

  it("should activate the revision for one tenant and keep it absent for another (isolation)", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });
    const installed = installRevision(authorDir, COMMIT_V1);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const store = newActivationStore();
    // Stage 5: activate for the host tenant, pinning the installed digest.
    const activated = store.activate({
      tenantId: TENANT_HOST,
      packId: PACK_ID,
      version: "1.0.0",
      contentDigest: installed.entry.contentDigest,
    });
    expect(activated.ok).toBe(true);

    // Stage 6: host tenant sees the pack problem; guest tenant does NOT.
    const hostInputs = store.snapshotInputsForTenant(TENANT_HOST);
    const guestInputs = store.snapshotInputsForTenant(TENANT_GUEST);
    expect(hostInputs.flatMap((p) => p.problems.map((q) => q.problemId))).toContain(
      "regional-network",
    );
    expect(guestInputs).toEqual([]);
  });

  it("should pin the catalog at event creation and resolve deployment provenance from the pin", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });
    const installed = installRevision(authorDir, COMMIT_V1);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const store = newActivationStore();
    store.activate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });

    // Stage 7: create the event -> pin the tenant's effective catalog snapshot.
    const events = new EventSnapshotStore(storeDir);
    const created = createEventSnapshot({
      eventId: EVENT_ID,
      tenantId: TENANT_HOST,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_HOST),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.put(created.snapshot);

    // The pin records the pack problem AND core, each with its provenance.
    const pinned = events.get(EVENT_ID);
    expect(pinned?.problems.map((p) => p.problemId).sort()).toEqual([
      "core-warmup",
      "regional-network",
    ]);

    // Stage 8: a deployment resolves provenance from the EVENT snapshot, not the
    // live catalog -- and the pack provenance carries the immutable digest.
    const provenance = resolveDeploymentProvenance(created.snapshot, "regional-network");
    expect(provenance?.source).toBe("pack");
    if (provenance?.source === "pack") {
      expect(provenance.packId).toBe(PACK_ID);
      expect(provenance.packVersion).toBe("1.0.0");
      expect(provenance.contentDigest).toBe(installed.entry.contentDigest);
    }
    expect(resolveDeploymentProvenance(created.snapshot, "core-warmup")?.source).toBe("core");
    // A problem id not in the pin resolves to undefined (fail closed).
    expect(resolveDeploymentProvenance(created.snapshot, "never-pinned")).toBeUndefined();
  });

  it("should keep the existing event pin UNCHANGED after deactivation and a newer revision install", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });
    installRevision(authorDir, COMMIT_V1);
    const store = newActivationStore();
    store.activate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });

    const events = new EventSnapshotStore(storeDir);
    const created = createEventSnapshot({
      eventId: EVENT_ID,
      tenantId: TENANT_HOST,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_HOST),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.put(created.snapshot);
    const pinnedBefore = events.get(EVENT_ID);

    // Stage 9a: deactivate the pinned revision for the tenant.
    store.deactivate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });
    // Stage 9b: author + install a NEWER revision (v2) from a different commit.
    const author2 = path.join(base, "fixture-repo", "external-pack-v2");
    authorPack(author2, { version: "2.0.0", problemId: "regional-network-v2" });
    const v2 = installRevision(author2, COMMIT_V2);
    expect(v2.ok).toBe(true);

    // Stage 10: the existing event's pin is byte-for-byte unchanged (immutable).
    const pinnedAfter = events.get(EVENT_ID);
    expect(pinnedAfter).toEqual(pinnedBefore);
    expect(pinnedAfter?.problems.some((p) => p.problemId === "regional-network")).toBe(true);
    expect(pinnedAfter?.problems.some((p) => p.problemId === "regional-network-v2")).toBe(false);
    // Provenance from the pin still resolves to the ORIGINAL v1.0.0 revision.
    const stillPinned = pinnedAfter;
    expect(stillPinned).toBeDefined();
    if (!stillPinned) return;
    expect(resolveDeploymentProvenance(stillPinned, "regional-network")?.source).toBe("pack");
  });

  it("should refuse to overwrite an event's pin even after the catalog changes underneath it", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });
    installRevision(authorDir, COMMIT_V1);
    const store = newActivationStore();
    store.activate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });

    const events = new EventSnapshotStore(storeDir);
    const created = createEventSnapshot({
      eventId: EVENT_ID,
      tenantId: TENANT_HOST,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_HOST),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.put(created.snapshot);

    // A second put for the same event id is refused -- the pin is immutable.
    expect(() => events.put(created.snapshot)).toThrow(/immutable/i);
  });

  it("should BLOCK removal while pinned and ALLOW it once every reference is gone", () => {
    authorPack(authorDir, { version: "1.0.0", problemId: "regional-network" });
    installRevision(authorDir, COMMIT_V1);
    const store = newActivationStore();
    store.activate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });

    const events = new EventSnapshotStore(storeDir);
    const created = createEventSnapshot({
      eventId: EVENT_ID,
      tenantId: TENANT_HOST,
      core: CORE,
      activePacks: store.snapshotInputsForTenant(TENANT_HOST),
      platform: PLATFORM,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.put(created.snapshot);

    // A revision is pinned when it is referenced by an active activation OR by a
    // pinned event. Both must be cleared before removal is allowed.
    const pinnedByEvent = (entry: PackLockEntry): boolean =>
      events
        .list()
        .some((e) =>
          e.problems.some(
            (p) =>
              p.provenance.source === "pack" &&
              p.provenance.packId === entry.packId &&
              p.provenance.packVersion === entry.version,
          ),
        );
    const isPinned = (entry: PackLockEntry): boolean =>
      store.isPinned(entry) || pinnedByEvent(entry);

    // Stage 11a: removal is BLOCKED while the activation AND the event reference it.
    const blockedActive = removePack(storeDir, PACK_ID, "1.0.0", isPinned);
    expect(blockedActive.ok).toBe(false);
    if (blockedActive.ok) return;
    expect(blockedActive.reason).toBe("PINNED");

    // Clear the activation; the event still pins it, so removal stays BLOCKED.
    store.deactivate({ tenantId: TENANT_HOST, packId: PACK_ID, version: "1.0.0" });
    const blockedByEvent = removePack(storeDir, PACK_ID, "1.0.0", isPinned);
    expect(blockedByEvent.ok).toBe(false);
    if (blockedByEvent.ok) return;
    expect(blockedByEvent.reason).toBe("PINNED");

    // Stage 11b: drop the event reference too (a real op would retire the event);
    // here we model "references removed" with a pin predicate that no longer pins
    // the revision via the event, so removal is now ALLOWED.
    const onlyActivationPins = (entry: PackLockEntry): boolean => store.isPinned(entry);
    const allowed = removePack(storeDir, PACK_ID, "1.0.0", onlyActivationPins);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.removed.packId).toBe(PACK_ID);
    // The lock no longer carries the removed revision.
    expect(
      readLock(storeDir).packs.some((p) => p.packId === PACK_ID && p.version === "1.0.0"),
    ).toBe(false);
  });
});
