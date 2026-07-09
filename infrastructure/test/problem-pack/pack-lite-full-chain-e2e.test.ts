/**
 * [Problem Packs / Issue #2459] Offline full-chain E2E.
 *
 * #2462 (Lite synth wiring), #2463 (scoring/endpoints projection composition), and #2464 (event
 * pin + deployment provenance runtime wiring) each landed with piecewise coverage, but nothing
 * proved the whole chain composes end-to-end. This file is the offline equivalent of the live AWS
 * run #2459 ultimately wants (that live run is tracked separately — CI does not deploy):
 *
 *   1. Author -> validate -> install -> activate a pack for tenant `local`, through the REAL
 *      offline `pack` CLI (`runPackCli`, same dispatcher `pack-cli-*.test.ts` exercises).
 *   2. Resolve that SAME activation store through the REAL Lite bin glue
 *      (`resolveLitePackCatalog`, extracted from `bin/tenkacloud-lite.ts` in this issue).
 *   3. Resolve the synth-time catalog through the REAL `resolveAppConfig`, the exact call
 *      `bin/tenkacloud-lite.ts` makes, and check the composed catalog / scoring / provenance.
 *   4. Feed that catalog into the REAL runtime seam: `buildEventSharedResources` (env parsing,
 *      including `BATTLE_PROBLEMS_CATALOG` / `BATTLE_PROBLEMS_PROVENANCE` the way esbuild
 *      `bundling.define` burns them in at synth time), the REAL `createEvent` handler (pins
 *      `catalogSnapshotId` + `packProvenance` onto the Event row), and the REAL
 *      `buildBulkDeployPlan` (stamps deployment provenance from the event pin).
 *
 * Only the AWS SDK transport (`ddb.send`) is faked; every step above is production code.
 *
 * A single shared fixture (`buildFixture`) runs the chain once (mirrors the "synth once, assert
 * many" idiom in `test/tenkacloud-lite-bin.test.ts`); the `it`s below assert on it in chain order.
 * A second `describe` covers the dormant (no pack store) branch, which the fixture above never
 * exercises since it always installs a pack.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { resolveLitePackCatalog } from "../../lib/app-wiring/lite-pack-catalog";
import { buildBulkDeployPlan } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/plan-builder";
import type { SelectedBulkDeployTargets } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/types";
import { createEvent } from "../../lib/problem-deploy/handlers/event-handler/create";
import {
  buildEventSharedResources,
  type EventSharedResources,
} from "../../lib/problem-deploy/handlers/event-handler/shared";
import { computeCatalogSnapshotId } from "../../lib/problem-pack/event-pin";
import { runPackCli } from "../../lib/problem-pack/pack-cli";

const PACK_ID = "com.example.starter"; // pack-cli.ts DEFAULT_INIT_PACK_ID
const PACK_VERSION = "0.1.0"; // init-pack.ts buildManifest
const PACK_PROBLEM_ID = "hello-world"; // init-pack.ts PROBLEM_ID
const CORE_PROBLEM_ID = "core-flag-check";
const TENANT_ID = "tenant-acme";
const AWS_ACCOUNT_ID = "111111111111";
const NOW_MS = 1_700_000_000_000;

const RUNTIME_ENV_KEYS = [
  "EVENTS_TABLE_NAME",
  "TEAMS_TABLE_NAME",
  "DEPLOYMENTS_TABLE_NAME",
  "COMPETITOR_ACCOUNTS_TABLE_NAME",
  "DISRUPTIONS_TABLE_NAME",
  "DEPLOY_EVENT_BUS_NAME",
  "DEPLOY_ENVIRONMENT",
  "BATTLE_PROBLEMS_CATALOG",
  "BATTLE_PROBLEMS_PROVENANCE",
] as const;

function baseAppConfigEnv(): NodeJS.ProcessEnv {
  return {
    CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
    CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
    CDK_SOURCE_NAME: "source.zip",
    CDK_PARAM_COMMIT_ID: "abcdef",
  };
}

/** Creates `<binDir>` under a fresh repo-root-shaped tmp tree, mirroring `import.meta.dirname`. */
function makeBinDir(repoRoot: string): string {
  const dir = path.join(repoRoot, "infrastructure", "bin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCoreProblem(repoRoot: string, id: string): void {
  const dir = path.join(repoRoot, "problems", "challenges", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      id,
      title: id,
      category: "challenges",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    }),
  );
}

function runCli(args: readonly string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = runPackCli(args, (line) => lines.push(line));
  return { code, out: lines.join("\n") };
}

/**
 * `pack init` does not emit a `scoring` declaration (see `buildMetadata` in
 * `lib/problem-pack/init-pack.ts`) — it only scaffolds a validator-passing skeleton with no
 * scoring rule. Add one here, mirroring the fixture packs in `resolve-pack-catalog.test.ts` /
 * `pack-cli-lifecycle.test.ts` (`{ kind: "flag", flagOutputKey: "Flag", points: 100 }`), so the
 * pack problem carries a real built-in scoring kind through the rest of the chain.
 */
function addScoringToScaffold(packDir: string): void {
  const metadataPath = path.join(
    packDir,
    "problems",
    "challenges",
    PACK_PROBLEM_ID,
    "metadata.json",
  );
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
  metadata.scoring = { kind: "flag", flagOutputKey: "Flag", points: 100 };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

async function buildFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-lite-full-chain-"));
  const bin = makeBinDir(base);
  const storeDir = path.join(base, ".tenkacloud", "pack-store");
  const packDir = path.join(base, "author", PACK_ID);
  writeCoreProblem(base, CORE_PROBLEM_ID);

  // ---- 1. Author -> validate -> install -> activate via the REAL offline `pack` CLI. ----
  const initResult = runCli(["init", packDir]);
  addScoringToScaffold(packDir);
  const validateResult = runCli(["validate", packDir]);
  const installResult = runCli(["install", packDir, "--store", storeDir]);
  const activateResult = runCli([
    "activate",
    `${PACK_ID}@${PACK_VERSION}`,
    "--tenant",
    "local",
    "--store",
    storeDir,
  ]);

  // ---- 2. Lite bin glue: resolve the SAME store the CLI just wrote to. ----
  const liteCatalog = resolveLitePackCatalog(bin);

  // ---- 3. Synth-time resolution: the exact `resolveAppConfig` call `bin/tenkacloud-lite.ts` makes. ----
  const cfg = resolveAppConfig({
    env: baseAppConfigEnv(),
    binDir: bin,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    catalogSource: liteCatalog?.catalogSource,
    packAssets: liteCatalog?.packAssets,
  });
  const catalog = cfg.problems.catalog as Record<string, string>;
  const scoring = cfg.problems.scoring as Record<string, unknown>;
  const provenance = (cfg.problems.provenance ?? {}) as Record<
    string,
    { source: string; packId: string; packVersion: string; contentDigest: string }
  >;
  const contentDigest = provenance[PACK_PROBLEM_ID]?.contentDigest ?? "";

  // ---- 4. Runtime half: feed the SAME catalog/provenance into the runtime seam through the REAL
  // env parsing (`buildEventSharedResources` reads `BATTLE_PROBLEMS_CATALOG` /
  // `BATTLE_PROBLEMS_PROVENANCE`, exactly what esbuild `bundling.define` burns in at synth time —
  // see `buildProblemDeployBackendBaseProps`), the REAL `createEvent`, and the REAL
  // `buildBulkDeployPlan`. Only `ddb.send` (the AWS SDK transport) is faked. ----
  process.env.EVENTS_TABLE_NAME = "Events";
  process.env.TEAMS_TABLE_NAME = "Teams";
  process.env.DEPLOYMENTS_TABLE_NAME = "Deployments";
  process.env.COMPETITOR_ACCOUNTS_TABLE_NAME = "CompetitorAccounts";
  process.env.DISRUPTIONS_TABLE_NAME = "Disruptions";
  process.env.DEPLOY_EVENT_BUS_NAME = "bus";
  process.env.DEPLOY_ENVIRONMENT = "development";
  process.env.BATTLE_PROBLEMS_CATALOG = JSON.stringify(catalog);
  process.env.BATTLE_PROBLEMS_PROVENANCE = JSON.stringify(provenance);

  const ddbSend = vi.fn().mockResolvedValue({});
  const shared: EventSharedResources = {
    ...buildEventSharedResources(),
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
  };

  const created = await createEvent(
    shared,
    { tenantId: TENANT_ID, nowMs: NOW_MS },
    {
      name: "Pack E2E Cup",
      teams: [{ internalSlug: "team-alpha", awsAccountId: AWS_ACCOUNT_ID }],
      problems: [
        { problemId: CORE_PROBLEM_ID, defaultRegion: "ap-northeast-1" },
        { problemId: PACK_PROBLEM_ID, defaultRegion: "ap-northeast-1" },
      ],
    },
  );
  const eventItem = (ddbSend.mock.calls[0]?.[0] as TransactWriteCommand).input.TransactItems?.[0]
    ?.Put?.Item as
    | {
        catalogSnapshotId?: string;
        packProvenance?: Record<
          string,
          { packId: string; packVersion: string; contentDigest: string }
        >;
      }
    | undefined;

  const expectedSnapshotId = computeCatalogSnapshotId(TENANT_ID, [
    { problemId: CORE_PROBLEM_ID, provenance: { source: "core" } },
    {
      problemId: PACK_PROBLEM_ID,
      provenance: { source: "pack", packId: PACK_ID, packVersion: PACK_VERSION, contentDigest },
    },
  ]);

  const plan = buildBulkDeployPlan({
    shared,
    tenantId: TENANT_ID,
    eventId: created.eventId,
    nowMs: NOW_MS,
    event: {
      startsAt: undefined,
      endsAt: undefined,
      catalogSnapshotId: eventItem?.catalogSnapshotId,
      packProvenance: eventItem?.packProvenance,
    },
    selected: {
      teams: [
        {
          eventId: created.eventId,
          teamId: "T1",
          tenantId: TENANT_ID,
          internalSlug: "team-alpha",
          teamLoginKey: "key-1",
          awsAccountId: AWS_ACCOUNT_ID,
        },
      ] as unknown as SelectedBulkDeployTargets["teams"],
      problems: [
        {
          problemId: CORE_PROBLEM_ID,
          defaultAwsAccountId: AWS_ACCOUNT_ID,
          defaultRegion: "ap-northeast-1",
        },
        {
          problemId: PACK_PROBLEM_ID,
          defaultAwsAccountId: AWS_ACCOUNT_ID,
          defaultRegion: "ap-northeast-1",
        },
      ] as unknown as SelectedBulkDeployTargets["problems"],
    },
    existing: {
      existingKey: new Set<string>(),
      failedByKey: new Map<string, { jobId: string }>(),
      forceRedeployByKey: new Map<string, { jobId: string }>(),
    },
    verified: new Map([
      [
        AWS_ACCOUNT_ID,
        {
          awsAccountId: AWS_ACCOUNT_ID,
          competitorRoleArn: `arn:aws:iam::${AWS_ACCOUNT_ID}:role/Role`,
          externalIdParameterName: `/tenkacloud/${TENANT_ID}/external-id`,
        },
      ],
    ]),
    retryFailedOnly: false,
    forceRedeploy: false,
  });

  return {
    base,
    initResult,
    validateResult,
    installResult,
    activateResult,
    liteCatalog,
    catalog,
    scoring,
    provenance,
    contentDigest,
    eventItem,
    expectedSnapshotId,
    plan,
  };
}

describe("Problem Pack Lite full-chain E2E (#2459)", () => {
  let fixture: Awaited<ReturnType<typeof buildFixture>>;

  beforeAll(async () => {
    fixture = await buildFixture();
  });

  afterAll(() => {
    for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
    fs.rmSync(fixture.base, { recursive: true, force: true });
  });

  it("should author, validate, install, and activate the pack for tenant 'local' via the real CLI", () => {
    expect(fixture.initResult.code).toBe(0);
    expect(fixture.validateResult.code).toBe(0);
    expect(fixture.installResult.code).toBe(0);
    expect(fixture.activateResult.code).toBe(0);
    expect(fixture.activateResult.out).toContain("activated");
    expect(fixture.activateResult.out).toContain("local");
  });

  it("should resolve a catalogSource + packAssets from the SAME store via the Lite bin glue", () => {
    expect(fixture.liteCatalog).toBeDefined();
    expect(fixture.liteCatalog?.packAssets).toEqual([
      {
        packId: PACK_ID,
        version: PACK_VERSION,
        problemsRootAbs: expect.stringContaining(PACK_ID),
      },
    ]);
  });

  it("should compose the pack problem into problems.catalog under a pack-problems/ directory key, alongside the core problem", () => {
    expect(fixture.catalog[CORE_PROBLEM_ID]).toBe(`problems/challenges/${CORE_PROBLEM_ID}`);
    expect(fixture.catalog[PACK_PROBLEM_ID]).toBe(
      `pack-problems/${PACK_ID}/${PACK_VERSION}/challenges/${PACK_PROBLEM_ID}`,
    );
  });

  it("should carry the pack problem's declared scoring kind into problems.scoring", () => {
    expect(fixture.scoring[PACK_PROBLEM_ID]).toEqual({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
    });
  });

  it("should record pack-only provenance in problems.provenance, leaving the core problem absent", () => {
    expect(fixture.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.provenance).toEqual({
      [PACK_PROBLEM_ID]: {
        source: "pack",
        packId: PACK_ID,
        packVersion: PACK_VERSION,
        contentDigest: fixture.contentDigest,
      },
    });
  });

  it("should pin catalogSnapshotId + packProvenance onto the created EventItem via the real createEvent handler", () => {
    expect(fixture.eventItem?.catalogSnapshotId).toBe(fixture.expectedSnapshotId);
    expect(fixture.eventItem?.packProvenance).toEqual({
      [PACK_PROBLEM_ID]: {
        packId: PACK_ID,
        packVersion: PACK_VERSION,
        contentDigest: fixture.contentDigest,
      },
    });
  });

  it("should stamp deployment provenance on the pack row and leave the core row untouched via the real bulk-deploy plan builder", () => {
    expect(fixture.plan.entries).toHaveLength(2);
    const packEntry = fixture.plan.entries.find(
      (entry) => entry.item.problemId === PACK_PROBLEM_ID,
    );
    const coreEntry = fixture.plan.entries.find(
      (entry) => entry.item.problemId === CORE_PROBLEM_ID,
    );
    expect(packEntry?.item.provenance).toEqual({
      packId: PACK_ID,
      packVersion: PACK_VERSION,
      contentDigest: fixture.contentDigest,
      catalogSnapshotId: fixture.expectedSnapshotId,
    });
    expect(coreEntry?.item).not.toHaveProperty("provenance");
  });
});

describe("Problem Pack Lite full-chain E2E — dormant branch (#2459)", () => {
  const bases: string[] = [];

  function makeDormantRoot(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-lite-dormant-"));
    bases.push(base);
    return base;
  }

  afterAll(() => {
    for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
  });

  it("should resolve undefined from the Lite bin glue when no local pack store exists", () => {
    const bin = makeBinDir(makeDormantRoot());

    expect(resolveLitePackCatalog(bin)).toBeUndefined();
  });

  it("should keep resolveAppConfig's problems bundle byte-identical to the no-catalogSource baseline", () => {
    const base = makeDormantRoot();
    const bin = makeBinDir(base);
    writeCoreProblem(base, CORE_PROBLEM_ID);
    const liteCatalog = resolveLitePackCatalog(bin);
    expect(liteCatalog).toBeUndefined();

    const withLiteWiring = resolveAppConfig({
      env: baseAppConfigEnv(),
      binDir: bin,
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
      catalogSource: liteCatalog?.catalogSource,
      packAssets: liteCatalog?.packAssets,
    });
    const baseline = resolveAppConfig({
      env: baseAppConfigEnv(),
      binDir: bin,
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
    });

    expect(withLiteWiring.problems).toEqual(baseline.problems);
    expect(withLiteWiring.problems.catalog).toEqual({
      [CORE_PROBLEM_ID]: `problems/challenges/${CORE_PROBLEM_ID}`,
    });
    expect("packAssets" in withLiteWiring).toBe(false);
  });
});
