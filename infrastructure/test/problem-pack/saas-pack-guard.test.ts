/**
 * [Problem Packs / Issue #2459] Tests for the SaaS-mode synth guard that fails loud when pack
 * activations exist. `bin/infrastructure.ts` (SaaS mode) never passes a `catalogSource` to
 * `resolveAppConfig`, so any pack activated via `make pack-activate` would otherwise vanish
 * silently on `make deploy-saas`. This suite exercises the REAL engine over a temp directory (no
 * FS mocks): packs are genuinely installed (#2094) and activated (#2095), matching the existing
 * `pack-activation.test.ts` fixture style.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPack } from "../../lib/problem-pack/lifecycle";
import { ActivationStore } from "../../lib/problem-pack/pack-activation";
import { assertSaasSynthHasNoActivePacks } from "../../lib/problem-pack/saas-pack-guard";

let base: string;
let binDir: string;
let storeDir: string;

const INSTALLED_AT = "2026-06-29T00:00:00.000Z";
const CORE_VERSION = "1.0.0";
const AVAILABLE_RUNTIMES = [{ provider: "aws", engine: "cloudformation" }] as const;

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-saas-pack-guard-"));
  // Mirrors `bin/tenkacloud-lite.ts`'s own resolution: <binDir>/../../.tenkacloud/pack-store.
  binDir = path.join(base, "infrastructure", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  storeDir = path.join(base, ".tenkacloud", "pack-store");
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

/** Build a minimal, fully-valid pack under `dir` and return `dir`. */
function writeValidPack(
  dir: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
): string {
  const problemId = options.problemId ?? "hello-world";
  const packManifest = manifest(options.manifestOverrides);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tenkacloud-pack.json"), JSON.stringify(packManifest, null, 2));
  const problemDir = path.join(dir, "problems", "challenges", problemId);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify({
      id: problemId,
      title: problemId,
      category: "challenges",
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    }),
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

describe("assertSaasSynthHasNoActivePacks (#2459)", () => {
  it("should not throw when the pack store directory does not exist", () => {
    // storeDir was never created (no install() call in this test).
    expect(fs.existsSync(storeDir)).toBe(false);

    expect(() => assertSaasSynthHasNoActivePacks(binDir, {})).not.toThrow();
  });

  it("should not throw when the store exists but has zero activations", () => {
    installPackFrom("pack-a");

    expect(() => assertSaasSynthHasNoActivePacks(binDir, {})).not.toThrow();
  });

  it("should throw listing the pack id, version, and tenant when one activation exists", () => {
    installPackFrom("pack-a");
    new ActivationStore(storeDir).activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });

    expect(() => assertSaasSynthHasNoActivePacks(binDir, {})).toThrow(
      /com\.example\.cloud-pack@1\.0\.0 \(tenant: tenant-a\)/,
    );
    try {
      assertSaasSynthHasNoActivePacks(binDir, {});
      throw new Error("expected assertSaasSynthHasNoActivePacks to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("#2459");
      expect(message).toContain("make pack-deactivate");
      expect(message).toContain("CDK_PARAM_SAAS_IGNORE_PACKS");
    }
  });

  it("should list every activation across multiple tenants in the thrown message", () => {
    installPackFrom("pack-a", { problemId: "problem-a" });
    installPackFrom("pack-b", {
      manifestOverrides: { id: "com.example.other-pack", version: "2.0.0" },
      problemId: "problem-b",
    });
    const store = new ActivationStore(storeDir);
    store.activate({ tenantId: TENANT_A, packId: "com.example.cloud-pack", version: "1.0.0" });
    store.activate({ tenantId: TENANT_B, packId: "com.example.other-pack", version: "2.0.0" });

    let thrown: unknown;
    try {
      assertSaasSynthHasNoActivePacks(binDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("com.example.cloud-pack@1.0.0 (tenant: tenant-a)");
    expect(message).toContain("com.example.other-pack@2.0.0 (tenant: tenant-b)");
  });

  it("should not throw and should warn once when the escape hatch env var is set", () => {
    installPackFrom("pack-a");
    new ActivationStore(storeDir).activate({
      tenantId: TENANT_A,
      packId: "com.example.cloud-pack",
      version: "1.0.0",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      assertSaasSynthHasNoActivePacks(binDir, { CDK_PARAM_SAAS_IGNORE_PACKS: "true" }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("CDK_PARAM_SAAS_IGNORE_PACKS");
    warnSpy.mockRestore();
  });
});
