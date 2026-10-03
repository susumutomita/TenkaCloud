import { StartAutomationExecutionCommand } from "@aws-sdk/client-ssm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapacityUnconfiguredError } from "../../lib/problem-deploy/handlers/event-handler/capacity";
import {
  CapacityNotApplicableError,
  CapacityScaleBodySchema,
  CapacityTableNotAllowedError,
  defaultCapacityScaleClients,
  startCapacityScale,
} from "../../lib/problem-deploy/handlers/event-handler/capacity-scale";

/**
 * Issue #2680: capacity scale service unit tests (`POST /admin/capacity` の write 側)。
 * capacity.test.ts (overview の read 側) と同じ shared / env fixture 構成で、SSM client は
 * fake を注入する。
 */

const SHARED = {
  deploymentsTableName: "Deployments-x",
  eventsTableName: "Events-x",
  teamsTableName: "Teams-x",
  disruptionsTableName: "Disruptions-x",
} as const;

beforeEach(() => {
  process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "Endpoints-x";
  process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME = "TestStack-event-capacity";
});

afterEach(() => {
  delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;
});

describe("CapacityScaleBodySchema", () => {
  it("should accept an in-range request and coerce string capacity values", () => {
    expect(
      CapacityScaleBodySchema.parse({
        tableName: "Deployments-x",
        readCapacityUnits: "25",
        writeCapacityUnits: 10,
      }),
    ).toEqual({ tableName: "Deployments-x", readCapacityUnits: 25, writeCapacityUnits: 10 });
  });

  // API 側の ceiling 再検証 (defense in depth): SSM allowedPattern をすり抜ける経路が
  // 出来ても、200 超 / 0 / 非整数はここで fail する。
  it.each([
    ["readCapacityUnits over the ceiling", { readCapacityUnits: 201 }],
    ["writeCapacityUnits over the ceiling", { writeCapacityUnits: 201 }],
    ["zero readCapacityUnits", { readCapacityUnits: 0 }],
    ["non-integer writeCapacityUnits", { writeCapacityUnits: 1.5 }],
    ["an empty tableName", { tableName: "" }],
  ])("should reject %s", (_label, override) => {
    const body = {
      tableName: "Deployments-x",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
      ...override,
    };
    expect(CapacityScaleBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("startCapacityScale", () => {
  const INPUT = { tableName: "Deployments-x", readCapacityUnits: 25, writeCapacityUnits: 10 };

  function buildScaleClients(response: unknown = { AutomationExecutionId: "exec-123" }) {
    const ssmSend = vi.fn(async () => response);
    return { clients: { ssm: { send: ssmSend as never } }, ssmSend };
  }

  it("should start the runbook with the table and stringified capacity parameters and return the execution id", async () => {
    const { clients, ssmSend } = buildScaleClients();

    const result = await startCapacityScale(SHARED, INPUT, clients);

    expect(result).toEqual({
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
    });
    expect(ssmSend).toHaveBeenCalledTimes(1);
    const cmd = ssmSend.mock.calls[0]?.[0] as StartAutomationExecutionCommand;
    expect(cmd).toBeInstanceOf(StartAutomationExecutionCommand);
    expect(cmd.input).toEqual({
      DocumentName: "TestStack-event-capacity",
      Parameters: {
        TableName: ["Deployments-x"],
        ReadCapacityUnits: ["25"],
        WriteCapacityUnits: ["10"],
      },
    });
    // AutomationAssumeRole は渡さない (= document default の least-privilege role を使う)。
    expect(cmd.input.Parameters?.AutomationAssumeRole).toBeUndefined();
  });

  it("should throw CapacityUnconfiguredError before touching AWS when the runbook env is unset", async () => {
    delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;

    // clients 引数を省略する = default 引数 (module-scope SSM client) の経路も一緒に踏む。
    // env 検査が先に fail するので実 AWS へは到達しない。
    await expect(startCapacityScale(SHARED, INPUT)).rejects.toThrow(CapacityUnconfiguredError);
  });

  it("should throw CapacityNotApplicableError when a pure SQL backend has no event-hot tables", async () => {
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
    const { clients, ssmSend } = buildScaleClients();

    await expect(
      startCapacityScale(
        {
          deploymentsTableName: "",
          eventsTableName: "",
          teamsTableName: "",
          disruptionsTableName: "",
        },
        INPUT,
        clients,
      ),
    ).rejects.toThrow(CapacityNotApplicableError);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("should throw CapacityTableNotAllowedError for a table outside the event-hot allowlist", async () => {
    const { clients, ssmSend } = buildScaleClients();

    await expect(
      startCapacityScale(SHARED, { ...INPUT, tableName: "SomeOtherTable" }, clients),
    ).rejects.toThrow(CapacityTableNotAllowedError);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("should fail loudly when the response has no AutomationExecutionId", async () => {
    const { clients } = buildScaleClients({});

    await expect(startCapacityScale(SHARED, INPUT, clients)).rejects.toThrow(
      /no AutomationExecutionId/,
    );
  });
});

describe("defaultCapacityScaleClients", () => {
  it("should cache the module-scope SSM client across calls", () => {
    const first = defaultCapacityScaleClients();
    expect(first.ssm).toBeDefined();
    expect(defaultCapacityScaleClients()).toBe(first);
  });
});
