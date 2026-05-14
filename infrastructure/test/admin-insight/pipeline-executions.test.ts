import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionConsoleUrl,
  type ListPipelineExecutionsDeps,
  listPipelineExecutions,
  summarizeExecution,
} from "../../lib/admin-insight/handlers/admin-insight-handler/pipeline-executions";

function buildDeps(send: ReturnType<typeof vi.fn>, region: string): ListPipelineExecutionsDeps {
  return {
    client: {
      send: send as unknown as ListPipelineExecutionsDeps["client"]["send"],
    },
    region,
  };
}

describe("buildExecutionConsoleUrl", () => {
  it("CodePipeline console の timeline deep link を組み立てるべき", () => {
    const url = buildExecutionConsoleUrl("ap-northeast-1", "tenkacloud-saas-pipeline", "exec-1");
    expect(url).toContain(
      "https://ap-northeast-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/tenkacloud-saas-pipeline/executions/exec-1/timeline",
    );
    expect(url).toContain("region=ap-northeast-1");
  });

  it("特殊文字を含む executionId を encode すべき", () => {
    const url = buildExecutionConsoleUrl("us-east-1", "p", "exec/with slash");
    expect(url).toContain("exec%2Fwith%20slash");
  });
});

describe("summarizeExecution", () => {
  it("status / start / lastUpdate / consoleUrl を抽出すべき", () => {
    const out = summarizeExecution("ap-northeast-1", "tenkacloud-saas-pipeline", {
      pipelineExecutionId: "exec-abc",
      status: "Succeeded",
      startTime: new Date("2026-05-13T20:00:00Z"),
      lastUpdateTime: new Date("2026-05-13T20:05:00Z"),
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.executionId).toBe("exec-abc");
    expect(out.status).toBe("Succeeded");
    expect(out.startTimeIso).toBe("2026-05-13T20:00:00.000Z");
    expect(out.lastUpdateTimeIso).toBe("2026-05-13T20:05:00.000Z");
    expect(out.consoleUrl).toContain("exec-abc");
  });

  it("executionId が無い summary は null を返すべき (= defensive)", () => {
    const out = summarizeExecution("ap-northeast-1", "p", {
      status: "Failed",
    });
    expect(out).toBeNull();
  });

  it('status が無ければ "Unknown" にフォールバックすべき', () => {
    const out = summarizeExecution("ap-northeast-1", "p", {
      pipelineExecutionId: "x",
    });
    expect(out?.status).toBe("Unknown");
  });
});

describe("listPipelineExecutions", () => {
  it("CodePipeline ListPipelineExecutionsCommand を pipelineName=tenkacloud-saas-pipeline で叩くべき", async () => {
    const send = vi.fn().mockResolvedValue({
      pipelineExecutionSummaries: [
        {
          pipelineExecutionId: "e1",
          status: "Succeeded",
          startTime: new Date("2026-05-13T19:00:00Z"),
          lastUpdateTime: new Date("2026-05-13T19:05:00Z"),
        },
      ],
    });
    const out = await listPipelineExecutions(buildDeps(send, "ap-northeast-1"), { limit: 10 });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = (send.mock.calls[0] as unknown[])[0] as {
      input: { pipelineName: string; maxResults?: number };
    };
    expect(cmd.input.pipelineName).toBe("tenkacloud-saas-pipeline");
    expect(cmd.input.maxResults).toBe(10);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].executionId).toBe("e1");
  });

  it("limit 未指定なら default=50 で呼ぶべき", async () => {
    const send = vi.fn().mockResolvedValue({ pipelineExecutionSummaries: [] });
    await listPipelineExecutions(buildDeps(send, "us-east-1"));
    const cmd = (send.mock.calls[0] as unknown[])[0] as {
      input: { maxResults?: number };
    };
    expect(cmd.input.maxResults).toBe(50);
  });

  it("limit を 100 で頭打ち (= MAX_LIMIT)", async () => {
    const send = vi.fn().mockResolvedValue({ pipelineExecutionSummaries: [] });
    await listPipelineExecutions(buildDeps(send, "us-east-1"), { limit: 999 });
    const cmd = (send.mock.calls[0] as unknown[])[0] as {
      input: { maxResults?: number };
    };
    expect(cmd.input.maxResults).toBe(100);
  });

  it("limit < 1 でも最低 1 で呼ぶべき (= defensive)", async () => {
    const send = vi.fn().mockResolvedValue({ pipelineExecutionSummaries: [] });
    await listPipelineExecutions(buildDeps(send, "us-east-1"), { limit: 0 });
    const cmd = (send.mock.calls[0] as unknown[])[0] as {
      input: { maxResults?: number };
    };
    expect(cmd.input.maxResults).toBe(1);
  });

  it("executionId が無い summary は drop すべき", async () => {
    const send = vi.fn().mockResolvedValue({
      pipelineExecutionSummaries: [
        { pipelineExecutionId: "e1", status: "Succeeded" },
        { status: "Failed" }, // executionId なし
        { pipelineExecutionId: "e2", status: "Running" },
      ],
    });
    const out = await listPipelineExecutions(buildDeps(send, "ap-northeast-1"));
    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.executionId)).toEqual(["e1", "e2"]);
  });
});
