#!/usr/bin/env bun
/**
 * [Issue #1667] Operator CLI to raise/lower DynamoDB provisioned capacity for an event window
 * WITHOUT a redeploy (the `DynamoDbLowCapacity` aspect re-pins to 1/1 on the next deploy, so this
 * is a deliberate, temporary override). Use it with the capacity model (scripts/capacity-model.ts)
 * and the capacity-pressure runbook: the model says when to scale, this does it.
 *
 *   bun run scripts/scale-event-capacity.ts <rcu> <wcu> <table...>           # dry-run (prints the plan)
 *   bun run scripts/scale-event-capacity.ts <rcu> <wcu> <table...> --apply    # execute UpdateTable
 *   bun run scripts/scale-event-capacity.ts 1 1 <table...> --apply            # return to baseline at teardown
 *
 * Pure plan + guardrails live in scripts/lib/scale-event-capacity.ts.
 */

import { DynamoDBClient, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import {
  applyCapacityPlan,
  DEFAULT_MAX_UNITS_PER_TABLE,
  planCapacityChange,
} from "../lib/scale-event-capacity";

interface ParsedArgs {
  readonly readCapacity: number;
  readonly writeCapacity: number;
  readonly tables: readonly string[];
  readonly apply: boolean;
  readonly maxUnitsPerTable: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let apply = false;
  let maxUnitsPerTable = DEFAULT_MAX_UNITS_PER_TABLE;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--max=")) maxUnitsPerTable = Number(a.slice("--max=".length));
    else positional.push(a);
  }
  return {
    readCapacity: Number(positional[0]),
    writeCapacity: Number(positional[1]),
    tables: positional.slice(2),
    apply,
    maxUnitsPerTable,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const plan = planCapacityChange({
    tables: args.tables,
    target: { readCapacity: args.readCapacity, writeCapacity: args.writeCapacity },
    maxUnitsPerTable: args.maxUnitsPerTable,
  });

  if (!plan.ok) {
    console.error("Cannot scale capacity:");
    for (const e of plan.errors) console.error(`  - ${e}`);
    console.error(
      "\nUsage: bun run scripts/scale-event-capacity.ts <rcu> <wcu> <table...> [--apply] [--max=N]",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Plan: set ${args.readCapacity} RCU / ${args.writeCapacity} WCU on ${args.tables.length} table(s):`,
  );
  for (const e of plan.entries) console.log(`  - ${e.table}`);
  for (const w of plan.warnings) console.warn(`  ⚠ ${w}`);

  if (!args.apply) {
    console.log("\nDry run. Re-run with --apply to execute UpdateTable.");
    return;
  }

  const client = new DynamoDBClient({});
  const result = await applyCapacityPlan(plan.entries, {
    updateTable: async (table, readCapacity, writeCapacity) => {
      await client.send(
        new UpdateTableCommand({
          TableName: table,
          ProvisionedThroughput: {
            ReadCapacityUnits: readCapacity,
            WriteCapacityUnits: writeCapacity,
          },
        }),
      );
    },
  });
  console.log(`\nApplied: ${result.applied.length}/${plan.entries.length} table(s).`);
  for (const f of result.failed) console.error(`  ✗ ${f.table}: ${f.error}`);
  if (result.failed.length > 0) process.exitCode = 1;
}

await main(process.argv.slice(2));
