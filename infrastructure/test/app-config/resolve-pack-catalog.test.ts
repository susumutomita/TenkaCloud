import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { installPack } from "../../lib/problem-pack/lifecycle";
import { ActivationStore, tenantCatalogSource } from "../../lib/problem-pack/pack-activation";

let base: string;

const PLATFORM = {
  coreVersion: "1.0.0",
  availableRuntimes: [{ provider: "aws", engine: "cloudformation" }],
} as const;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-resolve-pack-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
    CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
    CDK_SOURCE_NAME: "source.zip",
    CDK_PARAM_COMMIT_ID: "abcdef",
  };
}

function binDir(): string {
  const dir = path.join(base, "infrastructure", "bin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProblem(root: string, id: string): void {
  const dir = path.join(root, "problems", "challenges", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      id,
      title: id,
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    }),
  );
}

function writePack(root: string, problemId: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "tenkacloud-pack.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "com.example.cloud-pack",
      version: "1.0.0",
      core: "^1.0.0",
      title: "Example Cloud Pack",
      description: "A sample pack of cloud problems.",
      license: "Apache-2.0",
      problemsRoot: "problems",
      requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    }),
  );
  const problemDir = path.join(root, "problems", "challenges", problemId);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify({
      id: problemId,
      title: problemId,
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
      endpoints: [
        {
          slot: "web",
          default: { from: "cfn-output", key: "WebUrl", appendPath: "/health" },
          overridable: true,
        },
      ],
      phases: [{ name: "attack", afterMinutes: 10 }],
      disruptions: [{ id: "latency", name: "Latency", eventDetailType: "LatencyFired" }],
      writeup: "パック問題の解説",
      i18n: { en: { writeup: "Pack problem writeup" } },
    }),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
}

function installAndActivatePack(storeDir: string, problemId: string): ActivationStore {
  const sourceDir = path.join(base, "pack-source");
  writePack(sourceDir, problemId);
  const installed = installPack({
    sourceDir,
    storeDir,
    installedAt: "2026-07-08T00:00:00.000Z",
    coreVersion: PLATFORM.coreVersion,
    availableRuntimes: PLATFORM.availableRuntimes,
  });
  if (!installed.ok) throw new Error(installed.message);
  const store = new ActivationStore(storeDir, PLATFORM);
  const activated = store.activate({
    tenantId: "local",
    packId: "com.example.cloud-pack",
    version: "1.0.0",
  });
  if (!activated.ok) throw new Error(activated.message);
  return store;
}

describe("resolveAppConfig pack catalog source (#2462)", () => {
  it("should include active pack problems in the resolved catalog", () => {
    writeProblem(base, "core-only");
    const store = installAndActivatePack(path.join(base, ".tenkacloud", "pack-store"), "pack-only");

    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: binDir(),
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
      catalogSource: tenantCatalogSource(store, "local", PLATFORM),
    });

    expect(cfg.problems.catalog).toMatchObject({
      "core-only": "problems/challenges/core-only",
      "pack-only": "pack-problems/com.example.cloud-pack/1.0.0/challenges/pack-only",
    });
    expect((cfg.problems.scoring as Record<string, unknown>)["pack-only"]).toEqual({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
    });
    expect((cfg.problems.endpoints as Record<string, unknown>)["pack-only"]).toEqual([
      {
        slot: "web",
        default: { from: "cfn-output", key: "WebUrl", appendPath: "/health" },
        overridable: true,
      },
    ]);
    expect((cfg.problems.phases as Record<string, unknown>)["pack-only"]).toEqual([
      { name: "attack", afterMinutes: 10 },
    ]);
    expect((cfg.problems.disruptions as Record<string, unknown>)["pack-only"]).toEqual([
      { id: "latency", name: "Latency", eventDetailType: "LatencyFired" },
    ]);
    expect((cfg.problems.writeups as Record<string, unknown>)["pack-only"]).toEqual({
      ja: "パック問題の解説",
      en: "Pack problem writeup",
    });
    expect(cfg.problems.provenance).toEqual({
      "pack-only": {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: expect.any(String),
      },
    });
  });

  it("should keep the core-only catalog byte-identical when no store source is supplied", () => {
    writeProblem(base, "core-only");

    const first = resolveAppConfig({
      env: baseEnv(),
      binDir: binDir(),
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
    });
    const second = resolveAppConfig({
      env: baseEnv(),
      binDir: binDir(),
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
    });

    expect(first.problems).toEqual(second.problems);
    expect(first.problems.catalog).toEqual({ "core-only": "problems/challenges/core-only" });
    expect(first.problems.provenance).toEqual({});
  });
});
