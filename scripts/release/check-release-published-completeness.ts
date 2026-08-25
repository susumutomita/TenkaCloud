import { appendFileSync, readFileSync } from "node:fs";
import {
  checkReleasePublishedCompleteness,
  parseReleasePublishedEvent,
  type ReleaseCompletenessResult,
} from "./release-published-completeness";

/**
 * CLI entry point for the post-publish completeness guard (#3024 structural gap). Run by
 * `.github/workflows/release-published-guard.yml` on the `release: published` webhook
 * event — the event that fires no matter how the Release was created (the sanctioned
 * `release-cli.yml` pipeline, `gh release create` by hand, or the web UI), unlike that
 * pipeline's own asset checks, which only run when it built the release itself.
 *
 * Reads `GITHUB_EVENT_PATH` rather than accepting the payload on argv or interpolated into
 * shell: that file is how the GitHub Actions runner hands over the webhook body already,
 * with no risk of a tag name or release body containing shell metacharacters ever reaching
 * a command line.
 */

function readEventPayload(eventPath: string): unknown {
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function writeStepSummary(
  summaryPath: string | undefined,
  result: ReleaseCompletenessResult,
): void {
  if (!summaryPath) return;
  const lines = [`## Release published completeness guard`, ""];
  if (!result.inScope) {
    lines.push(`Not evaluated: ${result.scopeReason}.`);
  } else if (result.passed) {
    lines.push(`PASS — ${result.summary}`);
  } else {
    lines.push(`FAIL — ${result.summary}`, "");
    lines.push("| Asset | Status |", "| --- | --- |");
    for (const name of result.requiredAssets) {
      lines.push(
        `| \`${name}\` | ${result.missingAssets.includes(name) ? "MISSING" : "present"} |`,
      );
    }
    if (result.unexpectedAssets.length > 0) {
      const unexpected = result.unexpectedAssets.map((name) => `\`${name}\``).join(", ");
      lines.push("", `Unexpected assets also attached: ${unexpected}.`);
    }
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      "GITHUB_EVENT_PATH is not set; this script must run inside a GitHub Actions job.",
    );
  }
  const event = parseReleasePublishedEvent(readEventPayload(eventPath));
  const result = checkReleasePublishedCompleteness(event);

  if (!result.inScope) {
    console.log(`SKIP ${result.tagName}: ${result.scopeReason}.`);
  } else if (result.passed) {
    console.log(`PASS ${result.tagName}: ${result.summary}`);
  } else {
    console.error(`FAIL ${result.tagName}: ${result.summary}`);
  }
  writeStepSummary(process.env.GITHUB_STEP_SUMMARY, result);

  if (result.inScope && !result.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
