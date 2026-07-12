import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  buildParticipantSharedResources,
  queryTeamItems,
} from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1418: 2 つの shared-resource builder (event-handler/shared.ts +
 * participant-handler/shared.ts) は 25-50% branch だった。 既存テストは build を mock するため
 * 実 build が通らない。 getEnv 必須 read、 optional env の default 枝、 parseProblemsDisruptions、
 * feature-flag 判定を pin する。 build は同期で client を構築するだけ (network なし)。
 */
const EVENT_ENV = {
  EVENTS_TABLE_NAME: "Events",
  TEAMS_TABLE_NAME: "Teams",
  DEPLOYMENTS_TABLE_NAME: "Deployments",
  COMPETITOR_ACCOUNTS_TABLE_NAME: "CompetitorAccounts",
  DISRUPTIONS_TABLE_NAME: "Disruptions",
  DEPLOY_EVENT_BUS_NAME: "bus",
  DEPLOY_ENVIRONMENT: "development",
};
const OPTIONAL_KEYS = [
  "PROBLEM_ENDPOINTS_TABLE_NAME",
  "BATTLE_PROBLEMS_SCORING",
  "PROBLEM_ENDPOINTS",
  "BATTLE_PROBLEMS_CATALOG",
  "BATTLE_PROBLEMS_DISRUPTIONS",
  "BATTLE_PROBLEMS_PROVENANCE",
  "BULK_DEPLOY_PAYLOAD_BUCKET",
  "BULK_DEPLOY_VIA_DISTRIBUTED_MAP",
  "SAKURA_APPRUN_BASE_URL",
];
const ALL_KEYS = [...Object.keys(EVENT_ENV), ...OPTIONAL_KEYS];

beforeEach(() => {
  for (const [k, v] of Object.entries(EVENT_ENV)) process.env[k] = v;
  for (const k of OPTIONAL_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

describe("buildEventSharedResources", () => {
  it("should read required env, defaulting optionals when absent", () => {
    const s = buildEventSharedResources(makeTestControlDataRuntime());
    expect(s.eventsTableName).toBe("Events");
    expect(s.disruptionsTableName).toBe("Disruptions");
    expect(s.bulkDeployPayloadBucket).toBe(""); // BULK_DEPLOY_PAYLOAD_BUCKET ?? ""
    expect(s.useBulkDistributedMap).toBe(false); // flag absent → false
    expect(s.problemsDisruptions).toEqual({}); // BATTLE_PROBLEMS_DISRUPTIONS absent → {}
    expect(s.problemsProvenance).toEqual({}); // BATTLE_PROBLEMS_PROVENANCE absent → {}
    expect(s.ddb).toBeDefined();
    expect(s.events).toBeDefined();
  });

  // [#2571] Bulk non-AWS single-provider adapter dispatch needs an SSM client +
  // the Sakura AppRun base URL override wired into EventApiLambda's shared
  // resources (mirrors deploy-handler's DeploySharedResources wiring exactly).
  it("should wire an SSM client for non-AWS adapter dispatch (#2571)", () => {
    const s = buildEventSharedResources(makeTestControlDataRuntime());
    expect(s.ssm).toBeDefined();
  });

  it("should default sakuraAppRunBaseUrl to undefined when SAKURA_APPRUN_BASE_URL is unset (#2571)", () => {
    expect(
      buildEventSharedResources(makeTestControlDataRuntime()).sakuraAppRunBaseUrl,
    ).toBeUndefined();
  });

  it("should honor SAKURA_APPRUN_BASE_URL when present (#2571)", () => {
    process.env.SAKURA_APPRUN_BASE_URL = "https://apprun.example.test";
    expect(buildEventSharedResources(makeTestControlDataRuntime()).sakuraAppRunBaseUrl).toBe(
      "https://apprun.example.test",
    );
  });

  it("should honor the optional env (bucket / distributed-map flag / disruptions catalog)", () => {
    process.env.BULK_DEPLOY_PAYLOAD_BUCKET = "payloads";
    process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP = "TRUE"; // case-insensitive
    process.env.BATTLE_PROBLEMS_DISRUPTIONS = JSON.stringify({ p1: [{ id: "d1" }] });
    process.env.BATTLE_PROBLEMS_PROVENANCE = JSON.stringify({
      p1: {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: "sha256-abc",
      },
    });
    const s = buildEventSharedResources(makeTestControlDataRuntime());
    expect(s.bulkDeployPayloadBucket).toBe("payloads");
    expect(s.useBulkDistributedMap).toBe(true);
    expect(s.problemsDisruptions).toMatchObject({ p1: [{ id: "d1" }] });
    expect(s.problemsProvenance).toEqual({
      p1: {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: "sha256-abc",
      },
    });
  });

  it("should fall back to {} when BATTLE_PROBLEMS_DISRUPTIONS is invalid JSON", () => {
    process.env.BATTLE_PROBLEMS_DISRUPTIONS = "{not json";
    expect(buildEventSharedResources(makeTestControlDataRuntime()).problemsDisruptions).toEqual({});
  });

  it("should fall back to {} and warn when BATTLE_PROBLEMS_PROVENANCE has an invalid shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.BATTLE_PROBLEMS_PROVENANCE = JSON.stringify({
      p1: { source: "core" },
    });
    expect(buildEventSharedResources(makeTestControlDataRuntime()).problemsProvenance).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BATTLE_PROBLEMS_PROVENANCE"));
    warn.mockRestore();
  });

  it("should treat a non-true distributed-map flag as false", () => {
    process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP = "false";
    expect(buildEventSharedResources(makeTestControlDataRuntime()).useBulkDistributedMap).toBe(
      false,
    );
  });

  it("should throw when a required env var is missing", () => {
    // [Issue #2441 Phase B PR-6 / #2442 Phase C2 / #2442 Phase C3] DEPLOYMENTS_TABLE_NAME,
    // COMPETITOR_ACCOUNTS_TABLE_NAME, and DISRUPTIONS_TABLE_NAME are no longer required (see
    // below); DEPLOY_EVENT_BUS_NAME remains a `getEnv`-required field.
    delete process.env.DEPLOY_EVENT_BUS_NAME;
    expect(() => buildEventSharedResources(makeTestControlDataRuntime())).toThrow();
  });

  // Issue #2440 (ADR-049 §5.1 Phase A5): pure SQL backend (turso|sql) 選択時は Events/Teams
  // table 自体が synth されず env も配線されない。cold start (module load) を fail-fast にすると
  // Lambda が Initialization Error で落ちるため、空文字 default に緩和した (= silent fallback
  // ではない。dynamodb/mirror backend の誤設定は runtime resolver 側の required チェックが
  // fail loud に受ける、runtime-repositories.test.ts で pin 済み)。
  it("should default eventsTableName/teamsTableName to '' when unset (pure SQL backend cold start)", () => {
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.TEAMS_TABLE_NAME;
    expect(() => buildEventSharedResources(makeTestControlDataRuntime())).not.toThrow();
    const s = buildEventSharedResources(makeTestControlDataRuntime());
    expect(s.eventsTableName).toBe("");
    expect(s.teamsTableName).toBe("");
  });

  // [Issue #2441 / Phase B PR-6] Deployments table is not synthesized under pure SQL
  // backends either (same condition as Events/Teams above), so this builder must not
  // fail-fast when DEPLOYMENTS_TABLE_NAME is absent.
  it("should default deploymentsTableName to '' when unset (pure SQL backend cold start)", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildEventSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildEventSharedResources(makeTestControlDataRuntime()).deploymentsTableName).toBe("");
  });

  // [Issue #2442 / Phase C2] CompetitorAccounts table is not synthesized under pure SQL
  // backends either (same condition as Events/Teams/Deployments above), so this builder
  // must not fail-fast when COMPETITOR_ACCOUNTS_TABLE_NAME is absent (EventApiLambda would
  // otherwise crash cold start for every route, not just competitor-accounts ones).
  it("should default competitorAccountsTableName to '' when unset (pure SQL backend cold start)", () => {
    delete process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
    expect(() => buildEventSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(
      buildEventSharedResources(makeTestControlDataRuntime()).competitorAccountsTableName,
    ).toBe("");
  });

  // [Issue #2442 / Phase C3] Disruptions table is not synthesized under pure SQL backends
  // either (same condition as Events/Teams/Deployments/CompetitorAccounts above), so this
  // builder must not fail-fast when DISRUPTIONS_TABLE_NAME is absent (EventApiLambda would
  // otherwise crash cold start for every route, not just disruption ones).
  it("should default disruptionsTableName to '' when unset (pure SQL backend cold start)", () => {
    delete process.env.DISRUPTIONS_TABLE_NAME;
    expect(() => buildEventSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildEventSharedResources(makeTestControlDataRuntime()).disruptionsTableName).toBe("");
  });

  // [Issue #2442 / Phase C4] AdminAuditLog table is not synthesized under pure SQL backends
  // either (same condition as Disruptions above). This field was born optional (`?? ""`) since
  // `routes/audit-log.ts` always tolerated an unwired audit table (旧 stack 互換), so there is
  // no throw-before/no-throw-after story here — just the default/explicit branches.
  it("should default adminAuditLogTableName to '' when unset", () => {
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
    expect(buildEventSharedResources(makeTestControlDataRuntime()).adminAuditLogTableName).toBe("");
  });

  it("should read ADMIN_AUDIT_LOG_TABLE_NAME when present", () => {
    process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "AdminAuditLog";
    expect(buildEventSharedResources(makeTestControlDataRuntime()).adminAuditLogTableName).toBe(
      "AdminAuditLog",
    );
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
  });
});

describe("buildParticipantSharedResources", () => {
  it("should default the endpoints table to '' when unset", () => {
    const s = buildParticipantSharedResources(makeTestControlDataRuntime());
    expect(s.tableName).toBe("Deployments");
    expect(s.eventsTableName).toBe("Events");
    expect(s.endpointsTableName).toBe(""); // PROBLEM_ENDPOINTS_TABLE_NAME ?? ""
    expect(s.ddb).toBeDefined();
    expect(s.ssm).toBeDefined();
  });

  it("should use PROBLEM_ENDPOINTS_TABLE_NAME when present", () => {
    process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "Endpoints";
    expect(buildParticipantSharedResources(makeTestControlDataRuntime()).endpointsTableName).toBe(
      "Endpoints",
    );
  });

  it("should throw when a required env var is missing", () => {
    // [Issue #2441 Phase B PR-6] DEPLOYMENTS_TABLE_NAME is no longer required (see below);
    // DEPLOY_ENVIRONMENT remains a `getEnv`-required field.
    delete process.env.DEPLOY_ENVIRONMENT;
    expect(() => buildParticipantSharedResources(makeTestControlDataRuntime())).toThrow();
  });

  // Issue #2440 (ADR-049 §5.1 Phase A5): pure SQL backend (turso|sql) では Events table 自体が
  // synth されず env も配線されない。cold start を fail-fast にすると Participant Portal Lambda
  // が落ちるため空文字 default に緩和した。
  it("should default eventsTableName to '' when unset (pure SQL backend cold start)", () => {
    delete process.env.EVENTS_TABLE_NAME;
    expect(() => buildParticipantSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildParticipantSharedResources(makeTestControlDataRuntime()).eventsTableName).toBe("");
  });

  // [Issue #2441 / Phase B PR-6] Deployments table is not synthesized under pure SQL
  // backends either (same condition as Events above), so this builder must not fail-fast
  // when DEPLOYMENTS_TABLE_NAME is absent.
  it("should default tableName to '' when DEPLOYMENTS_TABLE_NAME is unset (pure SQL backend cold start)", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildParticipantSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildParticipantSharedResources(makeTestControlDataRuntime()).tableName).toBe("");
  });
});

describe("queryTeamItems", () => {
  it("should return the queried items", async () => {
    const shared = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send: vi.fn().mockResolvedValue({ Items: [{ jobId: "j1" }] }) },
      tableName: "Deployments",
    } as unknown as ParticipantSharedResources;
    expect(await queryTeamItems(shared, "key")).toHaveLength(1);
  });

  it("should default to [] when the query returns no Items", async () => {
    const shared = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send: vi.fn().mockResolvedValue({}) },
      tableName: "Deployments",
    } as unknown as ParticipantSharedResources;
    expect(await queryTeamItems(shared, "key")).toEqual([]);
  });
});
