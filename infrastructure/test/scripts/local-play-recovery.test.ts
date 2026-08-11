import { describe, expect, it, vi } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import { createLocalPlayState } from "../../../scripts/local-play/api-state";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import { PORT_STRIDE, remapContainerProblem } from "../../../scripts/local-play/port-remap";

const PROBLEM: ContainerProblem = {
  problemId: "sqli-demo",
  name: "SQL Injection Demo",
  description: "Vulnerable login.",
  instructions: "Open http://127.0.0.1:18080/.",
  problemDir: "/repo/problems/sqli-demo",
  composePath: "/repo/problems/sqli-demo/local/docker-compose.yml",
  composeProjectName: "tc-local-sqli-demo",
  challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
  verifyUrl: "http://127.0.0.1:18081/verify",
  secretEnv: ["FLAG_SEED"],
  scoring: { kind: "verify", points: 200, wrongAnswerPenalty: 0, hints: [] },
};

describe("local-play recovered API state (#3016)", () => {
  it("should adopt a live container with its offset, remapped URLs and stop handle", async () => {
    const portMap = new Map([
      [18080, 18080 + PORT_STRIDE],
      [18081, 18081 + PORT_STRIDE],
    ]);
    const unit = {
      problemId: PROBLEM.problemId,
      offset: PORT_STRIDE,
      composePath: "/local/tc-local-sqli-demo.compose.yml",
      composeProjectName: PROBLEM.composeProjectName,
      secretEnv: PROBLEM.secretEnv,
      projectDirectory: "/repo/problems/sqli-demo/local",
      remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
    };
    const startContainer = vi.fn(async () => {
      throw new Error("an adopted container must not be started again");
    });
    const stopContainer = vi.fn();
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        maxRunning: 2,
        startContainer,
        stopContainer,
        recoveredContainers: [
          {
            offset: PORT_STRIDE,
            started: { unit, problem: remapContainerProblem(PROBLEM, portMap) },
          },
        ],
      },
    );

    await expect(state.lifecycle.ensureRunning(PROBLEM.problemId)).resolves.toBe(PORT_STRIDE);
    expect(startContainer).not.toHaveBeenCalled();
    const response = await handleLocalPlayRequest(
      { method: "GET", path: "/portal/me", query: {}, body: undefined },
      state,
      Date.UTC(2026, 7, 11),
    );
    const recovered = (
      response.body as {
        problems: {
          lifecycle: { status: string };
          stackOutputs: Record<string, string>;
        }[];
      }
    ).problems[0];
    expect(recovered.lifecycle.status).toBe("running");
    expect(recovered.stackOutputs.Web).toBe("http://127.0.0.1:19080/");

    await state.lifecycle.stop(PROBLEM.problemId);
    expect(stopContainer).toHaveBeenCalledWith(unit);
  });

  it("should reject recovered state whose lifecycle and unit offsets disagree", () => {
    const unit = {
      problemId: PROBLEM.problemId,
      offset: 0,
      composePath: PROBLEM.composePath,
      composeProjectName: PROBLEM.composeProjectName,
      secretEnv: PROBLEM.secretEnv,
    };
    expect(() =>
      createLocalPlayState(
        { problems: [PROBLEM] },
        {
          maxRunning: 2,
          recoveredContainers: [{ offset: PORT_STRIDE, started: { unit, problem: PROBLEM } }],
        },
      ),
    ).toThrow(/Invalid recovered container/);
  });
});
