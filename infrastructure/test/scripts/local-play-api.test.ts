import { describe, expect, it } from "vitest";
import {
  createLocalPlayState,
  handleLocalPlayRequest,
  isLocalApiHealthy,
  type LocalPlayRequest,
} from "../../../scripts/local-play/api";
import type { LocalPlayDeployment } from "../../../scripts/local-play/kumo";

const NOW = 1_700_000_000_000;

function deployment(): LocalPlayDeployment {
  return {
    problem: {
      problemId: "hello-world",
      name: "Hello World",
      description: "Read the deployed SSM parameter.",
      instructions: "Submit the TC{...} value.",
      templatePath: "/repo/problems/challenges/hello-world/template.yaml",
      cfnParameters: {},
      scoring: {
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 5,
        hints: [],
      },
    },
    stackName: "tc-hello-world-kumo",
    outputs: {
      ParameterName: "/tc-hello-world-kumo/hello",
      ParameterValue: "TC{real-kumo-flag}",
      NamePrefix: "tc-hello-world-kumo",
    },
    expectedFlag: "TC{real-kumo-flag}",
    discoveryCommand:
      "aws --endpoint-url http://127.0.0.1:4566 ssm get-parameter --name /tc-hello-world-kumo/hello",
  };
}

function request(
  partial: Partial<LocalPlayRequest> & Pick<LocalPlayRequest, "method" | "path">,
): LocalPlayRequest {
  return { query: {}, body: undefined, ...partial };
}

describe("local-play API", () => {
  it("should expose the deployed problem without leaking its flag output", () => {
    const state = createLocalPlayState(deployment());
    const response = handleLocalPlayRequest(
      request({ method: "GET", path: "/portal/me" }),
      state,
      NOW,
    );

    expect(response.status).toBe(200);
    const body = response.body as {
      problems: Array<{
        instructions: string;
        stackOutputs: Record<string, string>;
        scoring: { flagSubmitted: boolean };
      }>;
    };
    expect(body.problems[0]?.stackOutputs).toEqual({
      ParameterName: "/tc-hello-world-kumo/hello",
      NamePrefix: "tc-hello-world-kumo",
    });
    expect(body.problems[0]?.instructions).toContain("aws --endpoint-url");
    expect(body.problems[0]?.scoring.flagSubmitted).toBe(false);
  });

  it("should reject a mock practice flag and accept only the deployed stack flag", () => {
    const state = createLocalPlayState(deployment());

    const wrong = handleLocalPlayRequest(
      request({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "hello-world", flag: "TC{local-hello-world}" },
      }),
      state,
      NOW,
    );
    expect(wrong.body).toEqual({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 0,
      wrongCount: 1,
    });

    const correct = handleLocalPlayRequest(
      request({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "hello-world", flag: "TC{real-kumo-flag}" },
      }),
      state,
      NOW + 1,
    );
    expect(correct.body).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
  });

  it("should apply the metadata wrong-answer penalty without making score negative", () => {
    const state = createLocalPlayState(deployment());
    state.score = 3;

    const response = handleLocalPlayRequest(
      request({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "hello-world", flag: "wrong" },
      }),
      state,
      NOW,
    );

    expect(response.body).toEqual({
      kind: "wrong",
      scoreDelta: -3,
      totalScore: 0,
      wrongCount: 1,
    });
  });

  it("should report one local team in leaderboard and score-event views", () => {
    const state = createLocalPlayState(deployment());
    handleLocalPlayRequest(
      request({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "hello-world", flag: "TC{real-kumo-flag}" },
      }),
      state,
      NOW,
    );

    const leaderboard = handleLocalPlayRequest(
      request({ method: "GET", path: "/portal/leaderboard" }),
      state,
      NOW,
    );
    const events = handleLocalPlayRequest(
      request({ method: "GET", path: "/portal/me/score-events" }),
      state,
      NOW,
    );

    expect(leaderboard.body).toMatchObject({
      eventId: "local",
      entries: [{ rank: 1, score: 100, completedProblems: 1, totalProblems: 1 }],
    });
    expect(events.body).toMatchObject({
      entries: [{ source: "flag", points: 100, result: "ok" }],
    });
  });
});

describe("isLocalApiHealthy", () => {
  const healthy = { status: "ok", mode: "localstack", problemId: "hello-world" };

  it("should accept this instance's own healthz payload for the expected problem", () => {
    expect(isLocalApiHealthy(healthy, "hello-world")).toBe(true);
  });

  it("should reject a foreign server serving a different problem on the same port", () => {
    expect(isLocalApiHealthy({ status: "ok", mode: "local" }, "hello-world")).toBe(false);
    expect(isLocalApiHealthy({ ...healthy, problemId: "clickfix-incident" }, "hello-world")).toBe(
      false,
    );
    expect(isLocalApiHealthy({ ...healthy, mode: "real" }, "hello-world")).toBe(false);
  });

  it("should reject non-object or empty payloads", () => {
    expect(isLocalApiHealthy(null, "hello-world")).toBe(false);
    expect(isLocalApiHealthy(undefined, "hello-world")).toBe(false);
    expect(isLocalApiHealthy("ok", "hello-world")).toBe(false);
    expect(isLocalApiHealthy({}, "hello-world")).toBe(false);
  });
});
