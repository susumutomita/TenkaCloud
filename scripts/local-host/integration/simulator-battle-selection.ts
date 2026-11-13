import { parseArgs } from "node:util";

/** Validate all effectful selections before starting the managed fixture. */
export function parseBattleRehearsalOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "run-two-team-deploy": { type: "boolean", default: false },
      "observe-automatic-revert": { type: "boolean", default: false },
      "observe-disruption": { type: "boolean", default: false },
      "repair-through-participant": { type: "boolean", default: false },
      binary: { type: "string" },
      "binary-sha256": { type: "string" },
      "runtime-config": { type: "string" },
      "catalog-snapshot": { type: "string" },
    },
  });
  if (!values["run-two-team-deploy"]) throw new Error("Explicit rehearsal selection required.");
  if (values["repair-through-participant"] && !values["observe-disruption"])
    throw new Error("Participant repair requires the disruption observation stage.");
  if (
    values["observe-automatic-revert"] &&
    (values["repair-through-participant"] || !values["observe-disruption"])
  )
    throw new Error("Automatic revert requires disruption observation without participant repair.");
  return values;
}
