import { CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { describe, expect, it, vi } from "vitest";
import { buildDeploymentProgressWriter } from "../../lib/problem-deploy/handlers/shared/deployment-progress-log.js";

describe("buildDeploymentProgressWriter (#2291)", () => {
  it("writes to the deterministic jobId stream", async () => {
    const send = vi.fn(async () => ({}));
    const write = buildDeploymentProgressWriter({ send }, "/tenkacloud/problem-deploy/progress");

    await write("01HXJOB", "CloudFormation create submitted");

    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateLogStreamCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      logGroupName: "/tenkacloud/problem-deploy/progress",
      logStreamName: "01HXJOB",
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutLogEventsCommand);
    expect(send.mock.calls[1][0].input).toMatchObject({
      logGroupName: "/tenkacloud/problem-deploy/progress",
      logStreamName: "01HXJOB",
      logEvents: [{ message: "CloudFormation create submitted" }],
    });
  });

  it("continues when the stream already exists", async () => {
    const alreadyExists = Object.assign(new Error("already exists"), {
      name: "ResourceAlreadyExistsException",
    });
    const send = vi.fn().mockRejectedValueOnce(alreadyExists).mockResolvedValueOnce({});
    const write = buildDeploymentProgressWriter({ send }, "/group");

    await write("01HXJOB", "polling");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutLogEventsCommand);
  });

  it("is fail-open when CloudWatch Logs rejects the write", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const write = buildDeploymentProgressWriter({ send }, "/group");
      await expect(write("01HXJOB", "polling")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
