import type { Plugin } from "vite";

const PROBLEM_METADATA_ID = /[/\\]problems[/\\][^/\\]+[/\\][^/\\]+[/\\]metadata\.json(?:\?.*)?$/u;

/**
 * Remove spoiler-bearing writeups before Vite's JSON plugin turns metadata into a JS module.
 * Projecting them out later is insufficient: Rollup may retain the original JSON object in the
 * browser bundle even when `metadataToEntry` never reads those properties.
 */
export function stripProblemWriteups(code: string, id: string): string | null {
  if (!PROBLEM_METADATA_ID.test(id)) return null;
  const metadata: unknown = JSON.parse(code);
  let changed = false;
  visitWriteups(metadata, (record) => {
    if (Object.hasOwn(record, "writeup")) {
      delete record.writeup;
      changed = true;
    }
  });
  return changed ? JSON.stringify(metadata) : null;
}

export function stripProblemWriteupsPlugin(): Plugin {
  return {
    name: "tenkacloud-strip-problem-writeups",
    enforce: "pre",
    transform: stripProblemWriteups,
  };
}

/** Includes problem-level and checkpoint-level JA/EN prose in the bundle leak check. */
export function collectProblemWriteups(metadata: unknown): string[] {
  const values: string[] = [];
  visitWriteups(metadata, (record) => {
    if (typeof record.writeup === "string" && record.writeup.length > 0) values.push(record.writeup);
  });
  return values;
}

/** Bundlers can encode newlines and quotes inside JavaScript string literals. */
export function containsProblemWriteup(bundle: string, writeup: string): boolean {
  return bundle.includes(writeup) || bundle.includes(JSON.stringify(writeup).slice(1, -1));
}

function visitWriteups(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) visitWriteups(child, visit);
}
