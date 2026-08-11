import { DEPLOY_NAMING_VECTORS, deploySlugify, deployStackPrefix } from "@TenkaCloud/trust-bridge";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStackPrefix,
  slugify,
} from "../../lib/problem-deploy/handlers/deploy-handler/naming.js";

/**
 * Issue #2555: parity pin between the trust-bridge naming
 * mirrors (used by the Always-On Worker to build the frozen deploy detail) and
 * the platform's authoritative `slugify` / `buildStackPrefix`. A drift here
 * would orphan a deployed stack from its destroy command, so any change must
 * update both sides together (same contract as deploy-command-patterns-parity).
 */
describe("deploy-command-naming parity (trust-bridge mirror vs deploy handler)", () => {
  it.each([
    ...DEPLOY_NAMING_VECTORS,
  ])("should slugify %j / %j identically on both sides", (problemId, teamName) => {
    expect(deploySlugify(problemId)).toBe(slugify(problemId));
    expect(deploySlugify(teamName)).toBe(slugify(teamName));
    expect(deployStackPrefix(problemId, teamName)).toBe(buildStackPrefix(problemId, teamName));
  });

  it("should preserve the legacy output for every shared naming vector", () => {
    const legacyOutputs = [
      ["hello-world", "team-alpha", "tc-hello-world-team-alpha"],
      ["wp-exposed-backup", "", "tc-wp-exposed-backup-"],
      ["a", "spaced-out", "tc-a-spaced-out"],
      ["upper-case-problem", "mixed-case-team", "tc-upper-case-problem-mixed-case-team"],
      ["x".repeat(40), "y".repeat(40), `tc-${"x".repeat(40)}-${"y".repeat(40)}`],
      ["dots-and-dashes", "leading-and-trailing", "tc-dots-and-dashes-leading-and-trailing"],
    ] as const;

    expect(DEPLOY_NAMING_VECTORS).toHaveLength(legacyOutputs.length);
    for (const [index, [problemId, teamName]] of DEPLOY_NAMING_VECTORS.entries()) {
      const expected = legacyOutputs[index];
      expect(expected).toBeDefined();
      expect([
        deploySlugify(problemId),
        deploySlugify(teamName),
        deployStackPrefix(problemId, teamName),
      ]).toEqual(expected);
    }
  });

  it("should avoid the polynomial trim regex in all naming sources", () => {
    const sources = [
      new URL("../../../packages/trust-bridge/src/deploy-command-naming.ts", import.meta.url),
      new URL("../../lib/problem-deploy/handlers/deploy-handler/naming.ts", import.meta.url),
      new URL("../../lib/problem-deploy/handlers/shared/events.ts", import.meta.url),
    ];

    for (const source of sources) {
      expect(readFileSync(source, "utf8")).not.toContain("/^-+|-+$/g");
    }
  });
});
