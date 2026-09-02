import { beforeEach, describe, expect, it, vi } from "vitest";
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
