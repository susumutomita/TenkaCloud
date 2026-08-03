#!/usr/bin/env bun
/**
 * [Issue #1667] CLI for the DynamoDB capacity model. Prints, for a range of team counts,
 * the Deployments table's sustained reads/writes per second and consumed capacity units
 * against the 1 RCU / 1 WCU `DynamoDbLowCapacity` ceiling, plus the team count at which it
 * first throttles. Run before an event to decide whether to raise capacity (see the
 * capacity-pressure runbook). Logic-level model — see scripts/lib/capacity-model.ts.
 *
 *   bun run scripts/capacity-model.ts            # default assumptions
 *   bun run scripts/capacity-model.ts 4 3        # problemsPerTeam=4 participantsPerTeam=3
 */

import {
  type CapacityInputs,
  DEFAULT_CAPACITY_INPUTS,
  maxTeamsBeforeThrottle,
  modelDeploymentsTable,
  PROVISIONED_RCU,
  PROVISIONED_WCU,
} from "../lib/capacity-model";

function round(n: number): string {
  return n.toFixed(2);
}

function formatRow(base: Omit<CapacityInputs, "teams">, teams: number): string {
  const m = modelDeploymentsTable({ ...base, teams });
  const throttled = [m.readThrottles ? "R" : "", m.writeThrottles ? "W" : ""].join("");
  const flag = throttled === "" ? "no" : `YES (${throttled})`;
  return (
    `  ${String(teams).padStart(5)} | ${String(m.deployments).padStart(11)} | ` +
    `${round(m.totalReadsPerSec).padStart(8)} | ${round(m.readCapacityUnits).padStart(4)} | ` +
    `${round(m.totalWritesPerSec).padStart(8)} | ${round(m.writeCapacityUnits).padStart(4)} | ${flag}`
  );
}

function throttleSummary(base: Omit<CapacityInputs, "teams">): string {
  const limit = maxTeamsBeforeThrottle(base);
  if (limit.limiting === "none") return "  → no throttling within the search range.";
  const axis = limit.limiting === "read" ? "reads (RCU)" : "writes (WCU)";
  return (
    `  → 1/1 provisioned holds up to ${limit.maxTeams} team(s); beyond that the Deployments ` +
    `table throttles on ${axis}. Raise capacity for the event window.`
  );
}

function main(argv: readonly string[]): void {
  const base: Omit<CapacityInputs, "teams"> = {
    ...DEFAULT_CAPACITY_INPUTS,
    problemsPerTeam: argv[0] ? Number(argv[0]) : DEFAULT_CAPACITY_INPUTS.problemsPerTeam,
    participantsPerTeam: argv[1] ? Number(argv[1]) : DEFAULT_CAPACITY_INPUTS.participantsPerTeam,
  };

  const lines = [
    "TenkaCloud Deployments-table capacity model (Issue #1667)",
    `  problems/team=${base.problemsPerTeam}  participants/team=${base.participantsPerTeam}  ` +
      `scoring tick=${base.scoringTickSeconds}s  poll=${base.participantPollSeconds}s  ` +
      `reads/poll/problem=${base.deploymentsReadsPerPoll}`,
    `  ceiling: ${PROVISIONED_RCU} RCU / ${PROVISIONED_WCU} WCU (DynamoDbLowCapacity)`,
    "",
    "  teams | deployments |  reads/s |  RCU | writes/s |  WCU | throttles",
    "  ------+-------------+----------+------+----------+------+----------",
    ...[5, 10, 20, 40, 80].map((teams) => formatRow(base, teams)),
    "",
    throttleSummary(base),
  ];
  console.log(lines.join("\n"));
}

main(process.argv.slice(2));
