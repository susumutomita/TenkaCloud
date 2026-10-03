import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisruptionDispatch } from "../../lib/problem-deploy/handlers/disruption-executor-handler/dispatch-command";
import type {
  DeploymentTarget,
  ExecutorDeps,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import { routeDisruptionInvocation } from "../../lib/problem-deploy/handlers/disruption-executor-handler/route";
import { fireDisruption } from "../../lib/problem-deploy/handlers/event-handler/disruption-fire";
import type { DisruptionFireInput } from "../../lib/problem-deploy/handlers/event-handler/disruption-types";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import type { ProblemDisruptionEntry } from "../../lib/utils/discover-problems-catalog";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1419 の **fire → executor 接合 (contract) test**。
 *
 * 各側の unit test (disruption-fire-mutation / disruption-execute / disruption-route) は片側しか触らない。
 * 一方 `disruption-fire.publishEntries` が `JSON.stringify` する `Detail` の形と、 executor 側
 * `parseDisruptionFiredDetail` が要求するフィールドは **規約でしか結ばれていない** (execute.ts のコメントに
 * 「= disruption-fire.publishEntries が JSON.stringify する形」とある通り)。 この test は operator fire が
 * publish した `*DisruptionFired` を EventBridge `{ detail }` envelope として executor router に渡し、
 * 競技者アカウント側 dispatch まで通すことで **その seam を end-to-end で pin する** (= #1419 受け入れ条件の
 * 「real (or LocalStack/integration) event causes an observable fault」を logic レベルで満たす検証)。
 * publish 側で 1 フィールドの名前が変われば、 この test が invalid_event で落ちて drift を検知する。
 *
 * 注: `CATALOG` を fire (`shared.problemsDisruptions`) と executor (`deps.problemsDisruptions`) の両方へ
 * 同一参照で渡しているのも意図的 — catalog (`eventDetailType` / `operatorEditable` / `action`) も両側が
 * 共有する契約なので、 同じ宣言で fire の merge と executor の dispatch 構築が噛み合うことを示す。
 */

const CATALOG: Record<string, ProblemDisruptionEntry[]> = {
  p1: [
    {
      id: "d1",
      eventDetailType: "Disruption.Latency",
      operatorEditable: ["latencyMs"],
      parameters: { base: 1 },
      action: {
        kind: "ssm-run-command",
        targetRef: "InstanceId",
        documentName: "AWS-RunShellScript",
        paramTemplate: { commands: ["inject {{latencyMs}}"] },
        revert: {
          afterSeconds: 120,
          documentName: "AWS-RunShellScript",
          paramTemplate: { commands: ["restore"] },
        },
      },
    },
  ],
};

const eventsSend = vi.fn();
const fireDdb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command (= disruption-fire-mutation と同型)。
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof QueryCommand) return { Items: [{ teamId: "team-1" }, { teamId: "team-2" }] };
    if (cmd instanceof GetCommand) return { Item: undefined };
    if (cmd instanceof PutCommand) return {};
    return {};
  }),
};
const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb: fireDdb,
  events: { send: eventsSend },
  eventBusName: "bus",
  teamsTableName: "Teams",
  disruptionsTableName: "Disruptions",
  problemsDisruptions: CATALOG,
} as unknown as EventSharedResources;

const fireInput = {
  tenantId: "t1",
  eventId: "e1",
  problemId: "p1",
  disruptionId: "d1",
  parameters: { latencyMs: 250 },
  scope: "all",
  targetTeamIds: [],
  requestId: "req-contract-1",
  firedBy: "sub-1",
  nowMs: 1_700_000_000_000,
} as DisruptionFireInput;

const TARGET: DeploymentTarget = {
  jobId: "job-1",
  region: "ap-northeast-1",
  competitorRoleArn: "arn:aws:iam::222222222222:role/ParticipantViewerRole",
  externalIdParameterName: "/tenkacloud/ext-id",
  stackOutputs: { InstanceId: "i-0abc123" },
};

const sent: { dispatch: DisruptionDispatch; target: DeploymentTarget }[] = [];
const reverts: { dispatch: DisruptionDispatch; afterSeconds: number }[] = [];
const deps: ExecutorDeps = {
  problemsDisruptions: CATALOG,
  claimExecution: vi.fn(async () => "claimed"),
  resolveDeployment: vi.fn(async () => TARGET),
  sendDispatch: vi.fn(async (dispatch, target) => {
    sent.push({ dispatch, target });
  }),
  scheduleRevert: vi.fn(async (_detail, dispatch, _target, afterSeconds) => {
    reverts.push({ dispatch, afterSeconds });
  }),
};

/** EventBridge rule が executor に渡すのと同じ `{ detail }` envelope へ畳む (= 1 published entry → 1 invocation)。 */
function firedEnvelopes(): { detail: Record<string, unknown> }[] {
  return eventsSend.mock.calls.flatMap((call) =>
    // biome-ignore lint/suspicious/noExplicitAny: PutEvents 入力の Entries を取り出す。
    (call[0].input.Entries as any[]).map((e) => ({ detail: JSON.parse(e.Detail) })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  reverts.length = 0;
  eventsSend.mockResolvedValue({ FailedEntryCount: 0 });
});

describe("disruption fire → executor contract (#1419)", () => {
  it("should carry a fired disruption end-to-end into the competitor-side inject + revert", async () => {
    const out = await fireDisruption(shared, fireInput);
    expect(out.kind).toBe("ok");

    const envelopes = firedEnvelopes();
    expect(envelopes).toHaveLength(2); // team-1 + team-2

    for (const envelope of envelopes) {
      const outcome = await routeDisruptionInvocation(envelope, deps);
      // parsed (= not invalid_event) AND injected against the resolved deployment.
      expect(outcome).toEqual({ kind: "ok", jobId: "job-1" });
    }

    // both teams injected with the same normalized dispatch; {{latencyMs}} substituted from the fired
    // (merged) parameters, target resolved from the team's stackOutputs[InstanceId].
    expect(sent).toHaveLength(2);
    expect(sent[0]?.dispatch).toEqual({
      kind: "ssm-run-command",
      target: "i-0abc123",
      documentName: "AWS-RunShellScript",
      params: { commands: ["inject 250"] },
    });
    // Every injection schedules a revert at the declared afterSeconds so the disruption always ends.
    expect(reverts).toHaveLength(2);
    expect(reverts[0]?.afterSeconds).toBe(120);
  });

  it("should publish a detail that satisfies every field the executor's parser requires", async () => {
    await fireDisruption(shared, fireInput);
    const [first] = firedEnvelopes();
    const detail = first?.detail ?? {};
    // parseDisruptionFiredDetail rejects unless these are all non-empty strings.
    for (const key of [
      "disruptionId",
      "eventId",
      "problemId",
      "tenantId",
      "teamId",
      "requestId",
      "firedAt",
    ]) {
      expect(typeof detail[key], `detail.${key} must be a string`).toBe("string");
      expect((detail[key] as string).length).toBeGreaterThan(0);
    }
    // fire merges declaration.parameters (base) with the operator-supplied value (latencyMs).
    expect(detail.parameters).toEqual({ base: 1, latencyMs: 250 });
    expect(detail.teamId).toBe("team-1");
  });

  it("should reject a fired detail that loses a required field, with no injection (seam-drift guard)", async () => {
    await fireDisruption(shared, fireInput);
    const [first] = firedEnvelopes();
    // simulate the publish side dropping teamId — the executor must fail loud, not silently inject.
    const { teamId: _dropped, ...drifted } = first?.detail ?? {};
    const outcome = await routeDisruptionInvocation({ detail: drifted }, deps);
    expect(outcome).toEqual({ kind: "invalid_event" });
    expect(deps.sendDispatch).not.toHaveBeenCalled();
    expect(deps.scheduleRevert).not.toHaveBeenCalled();
  });
});
