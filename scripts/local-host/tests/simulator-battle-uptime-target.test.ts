import { expect, test } from "bun:test";
import type { Job } from "../model";
import { battleOwnerKey } from "../simulator-battle-binding";
import {
  battleRegistrationLocator,
  battleUptimeTarget,
  simulatorBattleUptimeTarget,
} from "../simulator-battle-uptime-target";
import { simulatorStackOrigin } from "../simulator-stack-origin";
import { digest } from "../store";
import { uptimeGeneration } from "../uptime";

function job(): Job {
  return {
    jobId: "job",
    eventId: "event",
    teamId: "team",
    problemId: "hello-world-battle",
    definition: JSON.stringify({
      kind: "cloudformation",
      problemId: "hello-world-battle",
      scoring: { kind: "uptime-flat" },
    }),
    offset: 0,
    status: "COMPLETE",
    deployedAt: 1700000000000,
    unit: JSON.stringify({
      kind: "cloudformation",
      stackId: "stack",
      outputs: { InstanceId: "i-one", Ec2HostHint: "not-authority" },
    }),
  };
}
test("target is immutable correlation only and binds exact saved unit/generation", () => {
  const source = job();
  const target = battleUptimeTarget(source);
  expect(target.kind).toBe("battle-deployment-correlation-only");
  expect(target.owner).toEqual({
    eventId: "event",
    teamId: "team",
    jobId: "job",
    unitHash: digest(source.unit ?? ""),
    deployedAt: 1700000000000,
    stackId: "stack",
    instanceId: "i-one",
  });
  expect(target.ownerKey).toBe(battleOwnerKey(target.owner));
  expect(target.generation).toBe(uptimeGeneration(source));
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.owner)).toBe(true);
  expect(battleRegistrationLocator(target, "frontend")).toBe(
    `simulator://${target.ownerKey}/frontend`,
  );
  expect(battleRegistrationLocator(target, "api")).toBe(`simulator://${target.ownerKey}/api`);
  source.teamId = "foreign";
  expect(target.owner.teamId).toBe("team");
});
const invalid: [string, (j: Job) => void][] = [
  [
    "pending",
    (j) => {
      j.status = "PENDING";
    },
  ],
  [
    "operation pending",
    (j) => {
      j.operation = "teardown";
    },
  ],
  [
    "wrong problem",
    (j) => {
      j.problemId = "hello-world";
    },
  ],
  [
    "no timestamp",
    (j) => {
      j.deployedAt = undefined;
    },
  ],
  [
    "zero timestamp",
    (j) => {
      j.deployedAt = 0;
    },
  ],
  [
    "unsafe timestamp",
    (j) => {
      j.deployedAt = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "no unit",
    (j) => {
      j.unit = null;
    },
  ],
  [
    "invalid unit JSON",
    (j) => {
      j.unit = "{";
    },
  ],
  [
    "wrong unit kind",
    (j) => {
      j.unit = JSON.stringify({
        kind: "compose",
        stackId: "stack",
        outputs: { InstanceId: "i-one" },
      });
    },
  ],
  [
    "no stack ID",
    (j) => {
      j.unit = JSON.stringify({ kind: "cloudformation", outputs: { InstanceId: "i-one" } });
    },
  ],
  [
    "no instance ID",
    (j) => {
      j.unit = JSON.stringify({ kind: "cloudformation", stackId: "stack", outputs: {} });
    },
  ],
  [
    "definition mismatch",
    (j) => {
      j.definition = JSON.stringify({
        kind: "cloudformation",
        problemId: "hello-world",
        scoring: { kind: "uptime-flat" },
      });
    },
  ],
  [
    "wrong scoring",
    (j) => {
      j.definition = JSON.stringify({
        kind: "cloudformation",
        problemId: "hello-world-battle",
        scoring: { kind: "flag" },
      });
    },
  ],
  [
    "invalid owner",
    (j) => {
      j.teamId = " team ";
    },
  ],
];
for (const [label, change] of invalid)
  test(`reject ${label}`, () => {
    const value = job();
    change(value);
    expect(() => battleUptimeTarget(value)).toThrow();
  });
test("redeployment and exact unit bytes change correlation locator", () => {
  const source = job(),
    target = battleUptimeTarget(source);
  expect(battleUptimeTarget({ ...source, deployedAt: 1700000000001 }).ownerKey).not.toBe(
    target.ownerKey,
  );
  expect(battleUptimeTarget({ ...source, unit: `${source.unit} ` }).ownerKey).not.toBe(
    target.ownerKey,
  );
  expect(battleUptimeTarget({ ...source, teamId: "other" }).ownerKey).not.toBe(target.ownerKey);
});

test("Battle runtime requires explicit own origin without changing correlation-only compatibility", () => {
  const source = job();
  expect(battleUptimeTarget(source).owner.teamId).toBe("team");
  expect(() => simulatorBattleUptimeTarget(source)).toThrow("explicit Simulator");
  const base = JSON.parse(source.unit ?? "null");
  const origin = simulatorStackOrigin(source);
  source.unit = JSON.stringify({ ...base, origin });
  expect(simulatorBattleUptimeTarget(source)).toEqual(battleUptimeTarget(source));
  for (const invalid of [
    null,
    { ...origin, version: 2 },
    { ...origin, extra: true },
    { ...origin, teamId: "other" },
  ]) {
    source.unit = JSON.stringify({ ...base, origin: invalid });
    expect(() => simulatorBattleUptimeTarget(source)).toThrow();
  }
  source.unit = JSON.stringify({ ...base, origin });
  const other = { ...source, jobId: "job-two", teamId: "team-two" };
  expect(() => simulatorBattleUptimeTarget(other)).toThrow("another deployment");
  other.unit = JSON.stringify({ ...base, origin: simulatorStackOrigin(other) });
  expect(simulatorBattleUptimeTarget(other).ownerKey).not.toBe(
    simulatorBattleUptimeTarget(source).ownerKey,
  );
});
