import { describe, expect, it } from "vitest";
import { parseProblemIds, planProblem } from "../../../scripts/local-play/deployment-plan";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";

const COMPOSE = [
  "services:",
  "  app:",
  "    ports:",
  '      - "127.0.0.1:18080:8080"',
  '      - "127.0.0.1:18081:8081"',
].join("\n");

const problem = (id: string): ContainerProblem =>
  ({
    problemId: id,
    name: id,
    description: "",
    instructions: "",
    problemDir: `/p/${id}`,
    composePath: `/p/${id}/local/docker-compose.yml`,
    composeProjectName: `tc-local-${id}`,
    challengeEndpoints: { Web: "http://127.0.0.1:18080" },
    verifyUrl: "http://127.0.0.1:18081/verify",
    secretEnv: [],
    scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
  }) as ContainerProblem;

describe("deployment-plan: parseProblemIds (#2392)", () => {
  it("should split, trim, drop blanks, and de-dup preserving order", () => {
    expect(parseProblemIds("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(parseProblemIds("a,,a, b,a")).toEqual(["a", "b"]);
    expect(parseProblemIds("solo")).toEqual(["solo"]);
    expect(parseProblemIds("  ,  ")).toEqual([]);
  });
});

describe("deployment-plan: planProblem (#2392)", () => {
  it("should leave the first problem (index 0) unremapped on its declared ports", () => {
    const plan = planProblem(problem("a"), 0, COMPOSE);
    expect(plan.offset).toBe(0);
    expect(plan.remapped).toBe(false);
    expect(plan.composeText).toBe(COMPOSE);
    expect(plan.problem.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18080" });
    expect(plan.problem.verifyUrl).toBe("http://127.0.0.1:18081/verify");
  });

  it("should move a later problem onto a distinct host-port block (compose + URLs)", () => {
    const plan = planProblem(problem("b"), 1, COMPOSE);
    expect(plan.offset).toBe(100);
    expect(plan.remapped).toBe(true);
    expect(plan.composeText).toContain('"127.0.0.1:18180:8080"');
    expect(plan.composeText).toContain('"127.0.0.1:18181:8081"');
    // the participant-facing URLs follow the same offset so they hit its container
    expect(plan.problem.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18180" });
    expect(plan.problem.verifyUrl).toBe("http://127.0.0.1:18181/verify");
    // metadata that is not a port is preserved
    expect(plan.problem.problemId).toBe("b");
    expect(plan.problem.scoring.kind).toBe("verify");
  });
});
