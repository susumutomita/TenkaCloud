#!/usr/bin/env bun
import { generateThirdPartyNotices } from "./lib/oss-notices";

function main(): void {
  const check = process.argv.includes("--check");
  const result = generateThirdPartyNotices({ check });
  const copyleft = result.collection.copyleftEntries;

  for (const warning of result.collection.warnings) console.warn(`WARN ${warning}`);
  for (const entry of copyleft) {
    console.warn(`WARN copyleft/non-permissive license detected: ${entry.name}@${entry.version}`);
  }

  if (check) {
    if (result.changed) {
      console.error(
        `NG ${result.outputPath} is out of date. Run: bun run scripts/generate-oss-notices.ts`,
      );
      process.exit(1);
    }
    console.log(
      `OK ${result.collection.entries.length} third-party package notice(s) are up to date.`,
    );
    return;
  }

  console.log(
    `Wrote ${result.outputPath} with ${result.collection.entries.length} third-party package notice(s).`,
  );
}

if (import.meta.main) main();
