import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkCoordinationCapacity,
  coordinationStateBudget,
  forecastCoordinationStateBytes,
  maxTeamsForCoordinationBudget,
  parseCoordinationStateForecast,
} from "../../lib/problem-deploy/control-data/domain/coordination-budget";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { checkBulkDeployCoordinationCapacity } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/capacity-preflight";
import { warnOnCoordinationCapacity } from "../../lib/problem-deploy/handlers/event-handler/coordination-capacity-warning";
import { buildEventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

/**
 * [Issue #3169] Refusing an event that cannot fit, before it is deployed.
 *
 * #3151 already refuses the WRITE that would not fit, which is the right last
 * line and the worst first one: by then the match is live. Everything needed to
 * answer "will this fit" is known when the operator presses deploy, and these
 * tests pin that the answer is given there instead.
 *
 * The measured numbers below are `ac26-crypto-battle`'s: 16.4 KB per team and
 * a 1.62 MB row at the platform's 99-team maximum, which fits Turso's 4 MiB
 * policy ceiling and does not fit DynamoDB's 384 KB.
 */
const AC26_PER_TEAM = 16_400;
const AC26_BASE = 6_000;
const forecast = { bytesPerTeam: AC26_PER_TEAM, baseBytes: AC26_BASE };

const dynamodb = coordinationStateBudget({ kind: "dynamodb" });
// The SQL arm carries a flavor this test does not care about; naming the value
// keeps the widening out of the literal, which the object-literal-assertion
// rule forbids.
const sqlBackend: Parameters<typeof coordinationStateBudget>[0] = { kind: "sql", flavor: "turso" };
const turso = coordinationStateBudget(sqlBackend);

describe("forecasting a coordination row before the event runs", () => {
  it("should extrapolate linearly from the problem's declaration", () => {
    expect(forecastCoordinationStateBytes(forecast, 0)).toBe(AC26_BASE);
    expect(forecastCoordinationStateBytes(forecast, 99)).toBe(AC26_BASE + AC26_PER_TEAM * 99);
  });

  it("should report the team count that fits rather than only that one does not", () => {
    // "too big" sends an operator to read the source. A number is a decision
    // they can act on.
    const max = maxTeamsForCoordinationBudget(forecast, dynamodb);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(99);
    expect(forecastCoordinationStateBytes(forecast, max)).toBeLessThanOrEqual(dynamodb.maxBytes);
    expect(forecastCoordinationStateBytes(forecast, max + 1)).toBeGreaterThan(dynamodb.maxBytes);
  });

  it("should refuse a 99-team match on DynamoDB and admit it on Turso", () => {
    // The whole point of a per-backend budget, stated before play rather than
    // discovered mid-match: the same event is fine on one backend and stops
    // dead on the other.
    expect(checkCoordinationCapacity(forecast, 99, dynamodb).kind).toBe("over");
    expect(checkCoordinationCapacity(forecast, 99, turso).kind).toBe("fits");
  });

  it("should call a match that clears the ceiling but passes the warning line tight", () => {
    const tightTeams = Math.ceil((turso.warnBytes - AC26_BASE) / AC26_PER_TEAM);
    expect(checkCoordinationCapacity(forecast, tightTeams, turso).kind).toBe("tight");
  });
});

describe("reading a problem's declaration", () => {
  it("should accept a complete declaration", () => {
    expect(
      parseCoordinationStateForecast({ plugin: "coordination/x.ts", stateBudget: forecast }),
    ).toEqual(forecast);
  });

  it.each([
    ["no declaration at all", undefined],
    ["no stateBudget", { plugin: "coordination/x.ts" }],
    ["only half of it", { stateBudget: { bytesPerTeam: 16_400 } }],
    ["a non-integer", { stateBudget: { bytesPerTeam: 1.5, baseBytes: 0 } }],
    ["a negative per-team cost", { stateBudget: { bytesPerTeam: -1, baseBytes: 0 } }],
    ["a string", { stateBudget: { bytesPerTeam: "16400", baseBytes: 0 } }],
  ])("should treat %s as undeclared rather than guessing", (_label, declaration) => {
    // Undeclared means unchecked, never "assumed small". Half a declaration
    // read as a whole one would let the missing side default to zero and admit
    // an event that does not fit.
    expect(parseCoordinationStateForecast(declaration)).toBeUndefined();
  });
});

/** The preflight reads only `problemId`; the rest of a target is irrelevant here. */
const problem = (problemId: string): { readonly problemId: string } => ({ problemId });

describe("the bulk-deploy preflight", () => {
  it("should refuse a problem whose forecast exceeds the backend ceiling", () => {
    const report = checkBulkDeployCoordinationCapacity({
      problems: [problem("ac26-crypto-battle")],
      eventTeamCount: 99,
      problemsCoordination: { "ac26-crypto-battle": { stateBudget: forecast } },
      budget: dynamodb,
    });
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.maxTeams).toBeLessThan(99);
  });

  it("should size against the whole event, not the teams this deploy covers", () => {
    // `bulkDeployEvent` runs against live events, so a deploy is often a
    // subset. One coordination row holds the match for EVERY team on the
    // problem, so sizing a partial deploy against its own subset would pass
    // each deploy while the shared row grew past the ceiling.
    const declaration = { "ac26-crypto-battle": { stateBudget: forecast } };
    const wholeEvent = checkBulkDeployCoordinationCapacity({
      problems: [problem("ac26-crypto-battle")],
      eventTeamCount: 99,
      problemsCoordination: declaration,
      budget: dynamodb,
    });
    const oneLateJoiner = checkBulkDeployCoordinationCapacity({
      problems: [problem("ac26-crypto-battle")],
      eventTeamCount: 1,
      problemsCoordination: declaration,
      budget: dynamodb,
    });
    expect(wholeEvent.refusals).toHaveLength(1);
    expect(oneLateJoiner.refusals).toHaveLength(0);
  });

  it("should not check a problem that declares nothing", () => {
    // Every coordination problem in the catalog predates the declaration.
    // Guessing for them would either block events that are fine or admit ones
    // that are not; the runtime guard still holds the line for them.
    const report = checkBulkDeployCoordinationCapacity({
      problems: [problem("legacy-battle")],
      eventTeamCount: 99,
      problemsCoordination: { "legacy-battle": { plugin: "coordination/legacy.ts" } },
      budget: dynamodb,
    });
    expect(report.refusals).toHaveLength(0);
    expect(report.tight).toHaveLength(0);
  });

  it("should report a tight problem without refusing it", () => {
    const tightTeams = Math.ceil((turso.warnBytes - AC26_BASE) / AC26_PER_TEAM);
    const report = checkBulkDeployCoordinationCapacity({
      problems: [problem("ac26-crypto-battle")],
      eventTeamCount: tightTeams,
      problemsCoordination: { "ac26-crypto-battle": { stateBudget: forecast } },
      budget: turso,
    });
    expect(report.refusals).toHaveLength(0);
    expect(report.tight).toHaveLength(1);
  });
});

describe("the event-creation warning", () => {
  it("should warn without refusing, and say the deploy will be", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnings = warnOnCoordinationCapacity({
      problems: [{ problemId: "ac26-crypto-battle" }],
      teamCount: 99,
      problemsCoordination: { "ac26-crypto-battle": { stateBudget: forecast } },
      budget: dynamodb,
      tenantId: "tenant-a",
      eventId: "EV1",
    });
    expect(warnings).toHaveLength(1);
    // The operator needs to know this is not merely advisory.
    expect(warnings[0]).toContain("will be refused");
    expect(warnings[0]).toContain("dynamodb");
  });

  it("should warn about a tight event without saying the deploy will be refused", () => {
    // The two warnings have to read differently: one is "change this or the
    // deploy stops", the other is "this will run, keep an eye on it". Same
    // wording for both would train an operator to ignore the one that matters.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tightTeams = Math.ceil((turso.warnBytes - AC26_BASE) / AC26_PER_TEAM);
    const warnings = warnOnCoordinationCapacity({
      problems: [{ problemId: "ac26-crypto-battle" }],
      teamCount: tightTeams,
      problemsCoordination: { "ac26-crypto-battle": { stateBudget: forecast } },
      budget: turso,
      tenantId: "tenant-a",
      eventId: "EV1",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("close to the limit");
    expect(warnings[0]).not.toContain("will be refused");
  });

  it("should stay silent for an event that fits", () => {
    expect(
      warnOnCoordinationCapacity({
        problems: [{ problemId: "ac26-crypto-battle" }],
        teamCount: 4,
        problemsCoordination: { "ac26-crypto-battle": { stateBudget: forecast } },
        budget: turso,
        tenantId: "tenant-a",
        eventId: "EV1",
      }),
    ).toEqual([]);
  });
});

describe("bulkDeployEvent refusing an event that cannot fit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should refuse before writing a row or publishing any work", async () => {
    // The reason the check lives here and not only in the write path: a refusal
    // at this point costs nothing to recover from. Anything published would
    // have to be unwound, and anything persisted would leave PENDING rows for a
    // deploy that must not happen.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { shared, ddbSend, eventsSend } = buildShared({
      problemsCoordination: { "hello-world": { stateBudget: forecast } },
      runtime: {
        ...makeTestControlDataRuntime(),
        coordinationStateBudget: () => dynamodb,
      },
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    // Past the DynamoDB ceiling for this forecast, which the pure tests above
    // put between 23 and 24 teams. Derived rather than hardcoded so a change to
    // either number moves this with it.
    ddbSend.mockResolvedValueOnce({
      Items: sampleTeams(maxTeamsForCoordinationBudget(forecast, dynamodb) + 1),
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(out.kind).toBe("capacity_exceeded");
    expect(out.kind === "capacity_exceeded" && out.refusals[0]).toContain("hello-world");
    // Nothing was published, and nothing beyond the two reads was written.
    expect(eventsSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("should deploy a tight event, having warned the operator about it", async () => {
    // Tight is a scheduling signal, not a refusal: the match fits, and an
    // operator who is told before the event runs can decide to shrink it. A
    // check that refused here would block events that work.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tightTeams = Math.ceil((turso.warnBytes - AC26_BASE) / AC26_PER_TEAM);
    const { shared, eventsSend, ddbSend } = buildShared({
      problemsCoordination: { "hello-world": { stateBudget: forecast } },
      runtime: { ...makeTestControlDataRuntime(), coordinationStateBudget: () => turso },
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(tightTeams) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(out.kind).toBe("ok");
    expect(eventsSend).toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "coordination.capacity-tight",
    );
  });

  it("should deploy normally when the same event fits the backend", async () => {
    // The other side of the same switch: this must not become a check that
    // refuses everything once a problem declares a budget at all.
    const { shared, eventsSend, ddbSend } = buildShared({
      problemsCoordination: { "hello-world": { stateBudget: forecast } },
      runtime: {
        ...makeTestControlDataRuntime(),
        coordinationStateBudget: () => turso,
      },
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(out.kind).toBe("ok");
    expect(eventsSend).toHaveBeenCalled();
  });
});

describe("reading the declaration out of the Lambda environment", () => {
  const original = process.env.BATTLE_PROBLEMS_COORDINATION;
  // `buildEventSharedResources` is the real entry point, so it wants the two
  // env vars the Lambda always has. Going through it rather than exporting the
  // parser keeps the test on the path production actually takes.
  beforeEach(() => {
    process.env.DEPLOY_EVENT_BUS_NAME = "test-bus";
    process.env.DEPLOY_ENVIRONMENT = "development";
  });
  afterEach(() => {
    process.env.BATTLE_PROBLEMS_COORDINATION = original;
  });

  const readEnv = (value: string | undefined): Readonly<Record<string, unknown>> => {
    // Assigning `undefined` rather than deleting: `process.env` coerces it to
    // the string "undefined" on some runtimes, so the absent case is expressed
    // as an empty string, which the parser treats identically.
    process.env.BATTLE_PROBLEMS_COORDINATION = value ?? "";
    return buildEventSharedResources(makeTestControlDataRuntime()).problemsCoordination;
  };

  it("should parse the declaration synth burned in", () => {
    expect(readEnv(JSON.stringify({ "ac26-crypto-battle": { stateBudget: forecast } }))).toEqual({
      "ac26-crypto-battle": { stateBudget: forecast },
    });
  });

  it("should read an unset value as an empty catalog", () => {
    // Not every deployment has a coordination problem, and one that has none
    // may not have the variable wired at all. That is not corruption.
    expect(readEnv(undefined)).toEqual({});
  });

  it.each([
    ["not JSON at all", "{oops"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"nope"'],
    ["JSON null", "null"],
  ])("should throw on a %s value rather than disabling the check (#3169)", (_label, value) => {
    // An empty catalog is already expressible as a valid `{}`, so a malformed
    // value can only mean the build or the deployment configuration is broken.
    // Folding it to `{}` would silently switch the capacity check off and let
    // an oversized event through — the failure this check exists to prevent,
    // now with nothing to trace it back to. This value is substituted at build
    // time, so failing at Lambda init surfaces it where it can be fixed.
    expect(() => readEnv(value)).toThrow(/BATTLE_PROBLEMS_COORDINATION/);
  });
});

describe("budget arithmetic at its edges", () => {
  it("should treat a problem that grows by nothing as fitting any event", () => {
    // Not reachable from a valid declaration (`bytesPerTeam` must be positive),
    // but the function is exported and the answer has to be the safe one rather
    // than a division by zero.
    expect(maxTeamsForCoordinationBudget({ bytesPerTeam: 0, baseBytes: 0 }, dynamodb)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("should fit zero teams when the base alone exceeds the ceiling", () => {
    // A problem whose empty state is already over budget cannot host anybody,
    // and saying "0 teams fit" is the honest answer rather than a negative one.
    const huge = { bytesPerTeam: 1, baseBytes: dynamodb.maxBytes + 1 };
    expect(maxTeamsForCoordinationBudget(huge, dynamodb)).toBe(0);
    expect(checkCoordinationCapacity(huge, 0, dynamodb).kind).toBe("over");
  });
});

describe("the scheduled deploy path", () => {
  // Every variable this describe sets is restored, not just the one under
  // test: `buildScheduledDeployResources` needs a whole environment to return
  // anything at all, and leaking those into later suites makes a failure show
  // up somewhere unrelated to the test that caused it.
  const ENV_KEYS = [
    "PROBLEM_COORDINATION",
    "DEPLOY_EVENT_BUS_NAME",
    "DEPLOY_ENVIRONMENT",
    "BATTLE_PROBLEMS_CATALOG",
    "COMPETITOR_ACCOUNTS_TABLE_NAME",
    "EVENTS_TABLE_NAME",
    "DEPLOYMENTS_TABLE_NAME",
    "TEAMS_TABLE_NAME",
  ] as const;
  const originals = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  afterEach(() => {
    for (const [key, value] of originals) process.env[key] = value;
  });

  it("should carry the same declaration the manual route checks (#3169)", async () => {
    // A DRAFT event whose `deployAt` comes round reaches the SAME
    // `bulkDeployEvent`. Leaving its declaration empty meant the guard held
    // only for the path an operator was watching, and a scheduled deploy
    // enqueued the very event the button would have refused.
    const { buildScheduledDeployResources } = await import(
      "../../lib/problem-deploy/handlers/event-handler/shared"
    );
    process.env.PROBLEM_COORDINATION = JSON.stringify({
      "ac26-crypto-battle": { stateBudget: forecast },
    });
    process.env.DEPLOY_EVENT_BUS_NAME = "test-bus";
    process.env.DEPLOY_ENVIRONMENT = "development";
    process.env.BATTLE_PROBLEMS_CATALOG = JSON.stringify({
      "ac26-crypto-battle": "problems/battles/ac26-crypto-battle",
    });
    process.env.COMPETITOR_ACCOUNTS_TABLE_NAME = "C";
    process.env.EVENTS_TABLE_NAME = "E";
    process.env.DEPLOYMENTS_TABLE_NAME = "D";
    process.env.TEAMS_TABLE_NAME = "T";

    const resources = buildScheduledDeployResources(makeTestControlDataRuntime());

    expect(resources?.problemsCoordination).toEqual({
      "ac26-crypto-battle": { stateBudget: forecast },
    });
  });
});
