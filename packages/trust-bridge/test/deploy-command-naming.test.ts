import { describe, expect, it } from "vitest";
import {
  DEPLOY_NAMING_VECTORS,
  deploySlugify,
  deployStackPrefix,
} from "../src/deploy-command-naming.js";

describe("deploy-command-naming", () => {
  it("should lowercase, dash-join, trim, and cap slugs at 40 chars", () => {
    expect(deploySlugify("Team Alpha")).toBe("team-alpha");
    expect(deploySlugify("  spaced   out  ")).toBe("spaced-out");
    expect(deploySlugify("MiXeD_case+team")).toBe("mixed-case-team");
    expect(deploySlugify("x".repeat(80))).toHaveLength(40);
    expect(deploySlugify("-leading-and-trailing-")).toBe("leading-and-trailing");
  });

  it("should collapse a fully non-alphanumeric input to the empty slug (caller must reject)", () => {
    expect(deploySlugify("チーム 天下")).toBe("");
  });

  it("should build the tc-{problem}-{team} stack prefix", () => {
    expect(deployStackPrefix("hello-world", "Team Alpha")).toBe("tc-hello-world-team-alpha");
  });

  it("should keep the parity vectors self-consistent (prefix embeds both slugs)", () => {
    for (const [problemId, teamName] of DEPLOY_NAMING_VECTORS) {
      expect(deployStackPrefix(problemId, teamName)).toBe(
        `tc-${deploySlugify(problemId)}-${deploySlugify(teamName)}`,
      );
    }
  });
});
