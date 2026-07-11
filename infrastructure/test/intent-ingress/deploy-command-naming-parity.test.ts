import { DEPLOY_NAMING_VECTORS, deploySlugify, deployStackPrefix } from "@TenkaCloud/trust-bridge";
import { describe, expect, it } from "vitest";
import {
  buildStackPrefix,
  slugify,
} from "../../lib/problem-deploy/handlers/deploy-handler/naming.js";

/**
 * ADR-050 (Issue #2555 slice C) — parity pin between the trust-bridge naming
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
});
