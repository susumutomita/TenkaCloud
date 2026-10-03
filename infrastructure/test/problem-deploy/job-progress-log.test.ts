import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import { describe, expect, it, vi } from "vitest";
import {
  makeJobProgressLogger,
  NOOP_JOB_PROGRESS_LOGGER,
  safeProgressInfo,
} from "../../lib/problem-deploy/handlers/cfn-deploy-handler/job-progress-log.js";

/**
 * Issue #2291: the Lambda deploy path writes deterministic progress lines to a
 * jobId-keyed CloudWatch stream so participants can watch a deploy that has no CodeBuild build.
 * The `logs` client is mocked (no network).
 */

const LOG_GROUP = "/tenkacloud/deploy-jobs";
const JOB_ID = "01HX0000000000000000000ABC";

describe("makeJobProgressLogger (#2291)", () => {
  it("should create the jobId stream once, then reuse it for subsequent writes", async () => {
    const send = vi.fn(async () => ({}));
    const logger = makeJobProgressLogger({
      logs: { send },
      logGroupName: LOG_GROUP,
      jobId: JOB_ID,
      now: () => 1_000,
    });

    await logger.info("first");
    await logger.info("second");

    const creates = send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof CreateLogStreamCommand);
    // CreateLogStream runs exactly once across the two writes (streamEnsured latch).
    expect(creates).toHaveLength(1);
    expect((creates[0] as CreateLogStreamCommand).input).toMatchObject({
      logGroupName: LOG_GROUP,
      logStreamName: JOB_ID,
    });
  });

  it("should put the event with the given message + timestamp on the jobId stream", async () => {
    const send = vi.fn(async () => ({}));
    const logger = makeJobProgressLogger({
      logs: { send },
      logGroupName: LOG_GROUP,
      jobId: JOB_ID,
      now: () => 42,
    });

    await logger.info("Deploying stack tc-x-y ...");

    const put = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof PutLogEventsCommand) as PutLogEventsCommand;
    expect(put).toBeInstanceOf(PutLogEventsCommand);
    expect(put.input).toMatchObject({
      logGroupName: LOG_GROUP,
      logStreamName: JOB_ID,
      logEvents: [{ timestamp: 42, message: "Deploying stack tc-x-y ..." }],
    });
  });

  it("should swallow ResourceAlreadyExistsException from CreateLogStream (idempotent)", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CreateLogStreamCommand) {
        throw new ResourceAlreadyExistsException({ message: "exists", $metadata: {} });
      }
      return {};
    });
    const logger = makeJobProgressLogger({
      logs: { send },
      logGroupName: LOG_GROUP,
      jobId: JOB_ID,
    });

    // Does not throw; still emits the PutLogEvents.
    await expect(logger.info("hello")).resolves.toBeUndefined();
    expect(send.mock.calls.some((c) => c[0] instanceof PutLogEventsCommand)).toBe(true);
  });

  it("should rethrow a non-'already exists' CreateLogStream error (fail loud)", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CreateLogStreamCommand) throw new Error("Throttling");
      return {};
    });
    const logger = makeJobProgressLogger({
      logs: { send },
      logGroupName: LOG_GROUP,
      jobId: JOB_ID,
    });

    await expect(logger.info("hello")).rejects.toThrow(/Throttling/);
    // Never reached PutLogEvents.
    expect(send.mock.calls.some((c) => c[0] instanceof PutLogEventsCommand)).toBe(false);
  });
});

describe("NOOP_JOB_PROGRESS_LOGGER (#2291)", () => {
  it("should be inert and resolve without any client call", async () => {
    await expect(NOOP_JOB_PROGRESS_LOGGER.info("anything")).resolves.toBeUndefined();
  });
});

describe("safeProgressInfo (#2291)", () => {
  it("should forward the message to the logger", async () => {
    const info = vi.fn(async () => {});
    await safeProgressInfo({ info }, "line");
    expect(info).toHaveBeenCalledWith("line");
  });

  it("should swallow a logger failure so logging never changes the deploy outcome", async () => {
    const info = vi.fn(async () => {
      throw new Error("CloudWatch down");
    });
    await expect(safeProgressInfo({ info }, "line")).resolves.toBeUndefined();
  });
});
