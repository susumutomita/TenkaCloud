#!/usr/bin/env bun
/**
 * Merges several `lcov.info` reports for the SAME sources into one.
 *
 * Needed because the CI coverage matrix now splits one workspace's test files across runners
 * (`scripts/workspace/run-coverage.ts --part <i>/<N>`). Each part instruments the whole workspace
 * but only executes its slice of the tests, so each part writes a COMPLETE file list with PARTIAL
 * hit counts. The infra critical-path ratchet (`scripts/quality/check-infra-critical-coverage.ts`)
 * reads a single `infrastructure/coverage/lcov.info`, so the parts have to be recombined before it
 * can judge anything.
 *
 * Concatenating the parts is NOT a merge: `parseLcovPerFile` sums `LF`/`LH` per `SF:` record, so a
 * file present in 6 parts would report 6x its line count as "found" and the ratchet would read a
 * ~6x understated percentage. The merge is therefore per line / per branch / per function:
 * `DA` counts for the same line are summed, `BRDA` for the same (line, block, branch) are summed,
 * `FNDA` for the same function name is summed, and every summary counter (`LF`/`LH`, `FNF`/`FNH`,
 * `BRF`/`BRH`) is RECOMPUTED from the merged records rather than added up.
 *
 * Codecov needs none of this — it merges uploads for one commit server-side — so this exists only
 * for the local/CI gate that reads the file directly.
 *
 * Usage: bun run scripts/workspace/merge-lcov.ts --out <path> <lcov> [<lcov> ...]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface FileRecord {
  /** line number -> execution count (summed across parts). */
  readonly lines: Map<number, number>;
  /** function name -> declaration line. */
  readonly functionLines: Map<string, number>;
  /** function name -> call count (summed across parts). */
  readonly functionHits: Map<string, number>;
  /** "<line>,<block>,<branch>" -> taken count, or null when every part reported `-`. */
  readonly branches: Map<string, number | null>;
}

function emptyRecord(): FileRecord {
  return {
    lines: new Map(),
    functionLines: new Map(),
    functionHits: new Map(),
    branches: new Map(),
  };
}

function addBranch(record: FileRecord, key: string, taken: string): void {
  const previous = record.branches.get(key);
  // `-` means "the branch was never reached in this part". It is not 0 taken: a branch reached
  // zero times in one part and 3 times in another is `3`, and one no part reached stays `-`, so
  // the recomputed BRF still counts it as a branch that exists but was not taken.
  if (taken === "-") {
    if (previous === undefined) record.branches.set(key, null);
    return;
  }
  const value = Number(taken);
  if (Number.isNaN(value)) return;
  record.branches.set(key, (previous ?? 0) + value);
}

/**
 * One handler per lcov counter line. A prefix -> handler table instead of an if/else chain: the
 * chain scored 40 on `noExcessiveCognitiveComplexity` (max 15), and each counter's merge rule
 * (sum by line / by name / by branch key) is easier to check when it stands alone.
 */
const LINE_HANDLERS: readonly {
  readonly prefix: string;
  readonly apply: (record: FileRecord, rest: string) => void;
}[] = [
  {
    prefix: "DA:",
    apply: (record, rest) => {
      const [lineNo, count] = rest.split(",");
      const n = Number(lineNo);
      const c = Number(count);
      if (Number.isNaN(n) || Number.isNaN(c)) return;
      record.lines.set(n, (record.lines.get(n) ?? 0) + c);
    },
  },
  {
    prefix: "FNDA:",
    apply: (record, rest) => {
      const idx = rest.indexOf(",");
      if (idx < 0) return;
      const count = Number(rest.slice(0, idx));
      const name = rest.slice(idx + 1);
      if (Number.isNaN(count)) return;
      record.functionHits.set(name, (record.functionHits.get(name) ?? 0) + count);
    },
  },
  {
    prefix: "FN:",
    apply: (record, rest) => {
      const idx = rest.indexOf(",");
      if (idx < 0) return;
      const lineNo = Number(rest.slice(0, idx));
      const name = rest.slice(idx + 1);
      if (Number.isNaN(lineNo)) return;
      record.functionLines.set(name, lineNo);
      record.functionHits.set(name, record.functionHits.get(name) ?? 0);
    },
  },
  {
    prefix: "BRDA:",
    apply: (record, rest) => {
      const parts = rest.split(",");
      if (parts.length < 4) return;
      addBranch(record, parts.slice(0, 3).join(","), parts[3]);
    },
  },
];

function applyLine(record: FileRecord, line: string): void {
  // "FNDA:" before "FN:" — the table is ordered so the longer prefix wins.
  for (const handler of LINE_HANDLERS) {
    if (line.startsWith(handler.prefix)) {
      handler.apply(record, line.slice(handler.prefix.length));
      return;
    }
  }
}

function recordFor(files: Map<string, FileRecord>, path: string): FileRecord {
  const existing = files.get(path);
  if (existing) return existing;
  const created = emptyRecord();
  files.set(path, created);
  return created;
}

function parseInto(files: Map<string, FileRecord>, lcov: string): void {
  let current: FileRecord | null = null;

  for (const rawLine of lcov.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      current = recordFor(files, line.slice(3).trim());
      continue;
    }
    if (line === "end_of_record") {
      current = null;
      continue;
    }
    if (current !== null) applyLine(current, line);
  }
}

function renderRecord(path: string, record: FileRecord): string[] {
  const out = ["TN:", `SF:${path}`];

  const functionNames = [...record.functionLines.keys()].sort((a, b) => {
    const lineDiff = (record.functionLines.get(a) ?? 0) - (record.functionLines.get(b) ?? 0);
    return lineDiff !== 0 ? lineDiff : a.localeCompare(b);
  });
  for (const name of functionNames) {
    out.push(`FN:${record.functionLines.get(name)},${name}`);
  }
  for (const name of functionNames) {
    out.push(`FNDA:${record.functionHits.get(name) ?? 0},${name}`);
  }
  out.push(`FNF:${functionNames.length}`);
  out.push(`FNH:${functionNames.filter((n) => (record.functionHits.get(n) ?? 0) > 0).length}`);

  const branchKeys = [...record.branches.keys()].sort(compareBranchKeys);
  for (const key of branchKeys) {
    const taken = record.branches.get(key);
    out.push(`BRDA:${key},${taken === null || taken === undefined ? "-" : taken}`);
  }
  out.push(`BRF:${branchKeys.length}`);
  out.push(`BRH:${branchKeys.filter((k) => (record.branches.get(k) ?? 0) > 0).length}`);

  const lineNumbers = [...record.lines.keys()].sort((a, b) => a - b);
  for (const lineNo of lineNumbers) {
    out.push(`DA:${lineNo},${record.lines.get(lineNo)}`);
  }
  out.push(`LF:${lineNumbers.length}`);
  out.push(`LH:${lineNumbers.filter((n) => (record.lines.get(n) ?? 0) > 0).length}`);
  out.push("end_of_record");
  return out;
}

/** Numeric on each of line/block/branch so BRDA rows come out in source order, not "10" < "9". */
function compareBranchKeys(a: string, b: string): number {
  const left = a.split(",").map(Number);
  const right = b.split(",").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function mergeLcov(contents: readonly string[]): string {
  const files = new Map<string, FileRecord>();
  for (const content of contents) {
    parseInto(files, content);
  }
  const paths = [...files.keys()].sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const path of paths) {
    const record = files.get(path);
    if (record) lines.push(...renderRecord(path, record));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export class UsageError extends Error {}

export interface MergeArgs {
  readonly out: string;
  readonly inputs: readonly string[];
}

export function parseArgs(argv: readonly string[]): MergeArgs {
  let out: string | undefined;
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      if (out !== undefined) throw new UsageError("--out was provided more than once");
      out = argv[i + 1];
      if (out === undefined) throw new UsageError("--out expects a path");
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`unknown argument "${arg}"`);
    inputs.push(arg);
  }
  if (out === undefined) throw new UsageError("--out <path> is required");
  if (inputs.length === 0) throw new UsageError("at least one input lcov file is required");
  return { out, inputs };
}

function main(): void {
  let args: MergeArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[merge-lcov] ${(error as Error).message}`);
    console.error("Usage: bun run scripts/workspace/merge-lcov.ts --out <path> <lcov> [<lcov>...]");
    process.exit(2);
    return;
  }

  const merged = mergeLcov(args.inputs.map((path) => readFileSync(path, "utf8")));
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, merged);
  console.log(`[merge-lcov] merged ${args.inputs.length} report(s) into ${args.out}`);
}

if (import.meta.main) {
  main();
}
