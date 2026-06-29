/**
 * [Problem Packs / Issue #2110] Versioned golden reference packs.
 *
 * The golden packs at `packs/golden/*` are the canonical, executable examples of
 * each authoring capability AND the early-warning compatibility suite: when an
 * unintended edit to a pack OR a breaking change to the public SDK/harness lands,
 * one of these assertions fails with the offending pack id and capability.
 *
 * Everything here runs through the SAME public contracts an external contributor
 * pack uses — `@tenkacloud/problem-sdk` (validation + report + composition) and
 * `@tenkacloud/problem-test` (local harness) — never a private import or a second
 * validator, and never a real cloud / network call.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompositeDeploymentPlan, COMPOSITE_PROVIDERS } from "@tenkacloud/problem-runtime";
import {
  buildPackReport,
  type CompositeRuntimeDescriptor,
  computeContentDigest,
  validatePackDirectory,
} from "@tenkacloud/problem-sdk";
import { runPackTests } from "@tenkacloud/problem-test";
import { describe, expect, it } from "vitest";
import {
  composeEffectiveCatalog,
  type PackSnapshotInput,
} from "../../../lib/problem-pack/effective-catalog";

/** Repo root is three levels up from `infrastructure/test/problem-pack/golden`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const GOLDEN_ROOT = path.join(REPO_ROOT, "packs", "golden");

/**
 * One golden pack and the capability it covers. `capability` is the early-warning
 * label the issue requires the matrix to report on failure. `contentDigest` pins
 * the deterministic snapshot so a drift in EITHER the pack OR the validator's view
 * of the pack bytes is caught.
 */
interface GoldenPack {
  readonly dir: string;
  readonly packId: string;
  readonly version: string;
  readonly capability: string;
  readonly problemIds: readonly string[];
  readonly contentDigest: string;
}

/**
 * The versioned golden reference packs. `contentDigest` is the golden snapshot:
 * regenerate it ONLY with a documented, intentional change (and bump `version`).
 */
const GOLDEN_PACKS: readonly GoldenPack[] = [
  {
    dir: "basic-aws-pack",
    packId: "com.tenkacloud.golden.basic-aws",
    version: "1.0.0",
    capability: "aws/cloudformation deploy-only + flag scoring",
    problemIds: ["golden-basic-deploy-bucket", "golden-basic-find-the-flag"],
    contentDigest: "2d3c7b2354a6758623bbc86095d00d0e0f9f91c5b3c79dfdc84bdd351a710e2e",
  },
  {
    dir: "portal-ui-pack",
    packId: "com.tenkacloud.golden.portal-ui",
    version: "1.0.0",
    capability: "participant portal extension + endpoints + uptime-flat scoring",
    problemIds: ["golden-portal-keep-it-up"],
    contentDigest: "24195b829f18760397c6db7648ac6b83f3db387a76aa5bbddb42770dd25ae8c3",
  },
  {
    dir: "multicloud-pack",
    packId: "com.tenkacloud.golden.multicloud",
    version: "1.0.0",
    capability: "four-provider composite runtime + composite-probe scoring",
    problemIds: ["golden-multicloud-four-corners"],
    contentDigest: "9a739fe88395d9091952c4092606f5d6dd50f114e8361949e50b9278ebce9a01",
  },
  {
    dir: "private-artifact-pack",
    packId: "com.tenkacloud.golden.private-artifact",
    version: "1.0.0",
    capability: "declared private payload / provenance + attack-detection scoring",
    problemIds: ["golden-private-sealed-payload"],
    contentDigest: "be80bef923bc1ce2852aa5362ddfefe2a004ab8e724ecb3724dac4461fc47ac9",
  },
];

function packDir(pack: GoldenPack): string {
  return path.join(GOLDEN_ROOT, pack.dir);
}

/** Read a pack file's raw bytes (for the no-secret / no-private-import scans). */
function readPackText(pack: GoldenPack, relative: string): string {
  return fs.readFileSync(path.join(packDir(pack), relative), "utf-8");
}

/** Recursively list every file under a directory, repo-relative, sorted. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

describe("golden reference packs (#2110)", () => {
  it("should ship at least the four required reference packs", () => {
    expect(GOLDEN_PACKS.length).toBeGreaterThanOrEqual(4);
    for (const pack of GOLDEN_PACKS) {
      expect(fs.existsSync(packDir(pack)), `${pack.dir} exists`).toBe(true);
    }
  });

  it("should live outside the core problems/ directory and import no core private modules", () => {
    for (const pack of GOLDEN_PACKS) {
      const dir = packDir(pack);
      expect(dir).not.toContain(`${path.sep}problems${path.sep}`);
      expect(dir.startsWith(GOLDEN_ROOT)).toBe(true);
    }
  });

  describe.each(GOLDEN_PACKS)("$dir [$capability]", (pack) => {
    it("should validate through the public SDK with zero diagnostics", () => {
      const result = validatePackDirectory(packDir(pack));

      expect(result.diagnostics, `${pack.packId} diagnostics`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.manifest?.id).toBe(pack.packId);
      expect(result.manifest?.version).toBe(pack.version);
      expect([...result.problemIds]).toEqual([...pack.problemIds]);
    });

    it("should pass the published-CLI report contract (buildPackReport)", () => {
      const report = buildPackReport(packDir(pack));

      expect(report.result, `${pack.packId} report`).toBe("passed");
      expect(report.diagnostics).toEqual([]);
      expect(report.packId).toBe(pack.packId);
      expect(report.packVersion).toBe(pack.version);
      expect(report.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should match its pinned deterministic content digest (golden snapshot)", () => {
      // Catches an unintended edit to the pack OR a change in how the validator
      // hashes pack bytes — either drifts the digest and fails here.
      expect(computeContentDigest(packDir(pack))).toBe(pack.contentDigest);
    });

    it("should be installable as an immutable snapshot with a stable digest", () => {
      // "Immutable snapshot": two independent digest computations of the same
      // bytes agree, so the install lock the platform records cannot drift.
      const first = computeContentDigest(packDir(pack));
      const second = computeContentDigest(packDir(pack));
      expect(first).toBe(second);
      expect(first).toBe(pack.contentDigest);
    });

    it("should pass its local harness fixtures", () => {
      const result = runPackTests(packDir(pack));

      const failing = result.results.filter((r) => !r.passed);
      expect(failing, `${pack.packId} failing cases: ${JSON.stringify(failing)}`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.passed).toBeGreaterThan(0);
    });

    it("should embed no secret or credential material", () => {
      // The packs are deliberately inert: a real secret here would be a leak. We
      // scan for obvious key/credential markers (the private-artifact pack proves
      // the contract by REFERENCE only, never by embedding a secret).
      const secretMarkers = [
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        /AKIA[0-9A-Z]{16}/,
        /aws_secret_access_key/i,
        /xox[baprs]-[0-9A-Za-z-]{10,}/,
      ];
      for (const abs of listFiles(packDir(pack))) {
        const text = fs.readFileSync(abs, "utf-8");
        for (const marker of secretMarkers) {
          expect(marker.test(text), `${path.relative(packDir(pack), abs)} has no secret`).toBe(
            false,
          );
        }
      }
    });

    it("should import no core private module from its author files", () => {
      // No golden pack file may reach into platform internals (a relative import
      // out of the pack, or the SDK's /internal entrypoint).
      for (const abs of listFiles(packDir(pack))) {
        if (!/\.(ts|tsx|js|jsx)$/.test(abs)) continue;
        const text = fs.readFileSync(abs, "utf-8");
        expect(text).not.toMatch(/from\s+["']\.\.\/\.\.\//);
        expect(text).not.toMatch(/@tenkacloud\/[\w-]+\/internal/);
        expect(text).not.toMatch(/infrastructure\/lib/);
      }
    });
  });

  it("should report pack id and capability for a core release matrix failure", () => {
    // The "core release matrix" view: validating every golden pack against the
    // CURRENT core/SDK and producing an actionable, per-pack compatibility row.
    const rows = GOLDEN_PACKS.map((pack) => {
      const report = buildPackReport(packDir(pack));
      return {
        packId: pack.packId,
        capability: pack.capability,
        result: report.result,
        diagnostics: report.diagnostics,
      };
    });

    const broken = rows.filter((row) => row.result !== "passed");
    // On a real break this message names the pack id + capability, not a stack trace.
    expect(broken, `compatibility report: ${JSON.stringify(broken)}`).toEqual([]);
    for (const row of rows) {
      expect(row.packId).toMatch(/^com\.tenkacloud\.golden\./);
      expect(row.capability.length).toBeGreaterThan(0);
    }
  });

  it("should preserve the four-provider composite declaration through catalog composition", () => {
    // The multicloud golden pack carries a composite runtime over all four
    // providers. Composition must NOT flatten or drop any provider target.
    const multicloud = GOLDEN_PACKS.find((p) => p.dir === "multicloud-pack");
    if (!multicloud) throw new Error("multicloud golden pack missing");
    const dir = packDir(multicloud);

    const validation = validatePackDirectory(dir);
    expect(validation.ok).toBe(true);
    const manifest = validation.manifest;
    if (!manifest) throw new Error("multicloud manifest did not parse");

    // The declared composite target providers, read straight from metadata.json.
    const metadata = JSON.parse(
      readPackText(multicloud, "problems/battles/four-corners/metadata.json"),
    ) as { runtime: CompositeRuntimeDescriptor };
    const declaredProviders = metadata.runtime.targets.map((t) => t.provider);
    expect([...declaredProviders].sort()).toEqual([...COMPOSITE_PROVIDERS].sort());

    // The deterministic deployment plan keeps every provider target in order.
    const plan = buildCompositeDeploymentPlan(metadata.runtime);
    expect(plan.targets.map((t) => t.provider)).toEqual(declaredProviders);

    // Compose an effective catalog from this pack against a platform that
    // advertises all four runtimes; the merged entry retains its provenance and
    // the problem id, and the composition does not reject the four-provider pack.
    const snapshot: PackSnapshotInput = {
      manifest,
      contentDigest: multicloud.contentDigest,
      problems: validation.problemIds.map((problemId) => ({
        problemId,
        directory: "problems/battles/four-corners",
        projections: { runtime: metadata.runtime },
      })),
    };
    const composed = composeEffectiveCatalog({
      core: [],
      packs: [snapshot],
      platform: {
        coreVersion: "1.0.0",
        availableRuntimes: [...manifest.requiredRuntimes],
      },
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const entry = composed.entries.find((e) => e.problemId === "golden-multicloud-four-corners");
    expect(entry?.provenance).toEqual({
      source: "pack",
      packId: multicloud.packId,
      packVersion: multicloud.version,
      contentDigest: multicloud.contentDigest,
    });
    const composedRuntime = entry?.projections.runtime as CompositeRuntimeDescriptor;
    expect(composedRuntime.targets.map((t) => t.provider).sort()).toEqual(
      [...COMPOSITE_PROVIDERS].sort(),
    );
  });

  it("should keep the golden digests independent of file enumeration order", () => {
    // Determinism guard for the snapshot itself: a hand recomputation over the
    // sorted file list must reproduce the SDK's content digest exactly.
    for (const pack of GOLDEN_PACKS) {
      const dir = packDir(pack);
      const files = listFiles(dir)
        .map((abs) => ({
          rel: path.relative(dir, abs).split(path.sep).join("/"),
          bytes: fs.readFileSync(abs),
        }))
        // Exclude dot-prefixed entries inside the pack (mirrors computeContentDigest).
        .filter((file) => !file.rel.split("/").some((seg) => seg.startsWith(".")))
        .sort((a, b) => (a.rel < b.rel ? -1 : 1));
      const hash = createHash("sha256");
      for (const file of files) {
        const pathBytes = Buffer.from(file.rel, "utf-8");
        hash.update(`${pathBytes.length}:`);
        hash.update(pathBytes);
        hash.update(`${file.bytes.length}:`);
        hash.update(file.bytes);
      }
      expect(hash.digest("hex")).toBe(pack.contentDigest);
    }
  });
});
