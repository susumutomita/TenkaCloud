import type { Plugin } from "vite";

const PROBLEM_METADATA_ID = /[/\\]problems[/\\][^/\\]+[/\\][^/\\]+[/\\]metadata\.json(?:\?.*)?$/u;

/**
 * Remove spoiler-bearing writeups before Vite's JSON plugin turns metadata into a JS module.
 * Projecting them out later is insufficient: Rollup may retain the original JSON object in the
 * browser bundle even when `metadataToEntry` never reads those properties.
 */
export function stripProblemWriteups(code: string, id: string): string | null {
  if (!PROBLEM_METADATA_ID.test(id)) return null;
  const metadata = JSON.parse(code) as {
    writeup?: unknown;
    i18n?: { en?: { writeup?: unknown; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
  };
  let changed = false;
  if (Object.hasOwn(metadata, "writeup")) {
    delete metadata.writeup;
    changed = true;
  }
  if (metadata.i18n?.en && Object.hasOwn(metadata.i18n.en, "writeup")) {
    delete metadata.i18n.en.writeup;
    changed = true;
  }
  return changed ? JSON.stringify(metadata) : null;
}

export function stripProblemWriteupsPlugin(): Plugin {
  return {
    name: "tenkacloud-strip-problem-writeups",
    enforce: "pre",
    transform: stripProblemWriteups,
  };
}
