import { describe, expect, it } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository";
import type {
  DeploymentRecord,
  DeploymentsRepository,
} from "../../lib/problem-deploy/control-data/types";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { submitFlag } from "../../lib/problem-deploy/handlers/participant-handler/submit-flag";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { mcpConfigFixture } from "./mcp-oauth-fixture";

const AT = "2026-09-06T00:00:00.000Z";
const EXPIRES = 4_102_444_800;
const backends = {
  dynamodb: () => new DynamoDbDeploymentsRepository(makeFakeDdb(), "Deployments"),
  sqlite: () => new SqlDeploymentsRepository(makeSqliteExecutor()),
};
const mutations = {
  correct: (r: DeploymentsRepository, id: string) => r.applyFlagCorrectScore(id, 10, AT),
  wrong: (r: DeploymentsRepository, id: string) => r.applyFlagWrongPenalty(id, 2, AT),
  multiCorrect: (r: DeploymentsRepository, id: string) =>
    r.applyMultiFlagCorrectScore(id, 10, "part", AT),
  multiWrong: (r: DeploymentsRepository, id: string) =>
    r.applyMultiFlagWrongPenalty(id, 2, "part", AT),
};
function bindingFixture() {
  const binding = mcpConfigFixture().bindings[0];
  if (!binding) throw new Error("Missing test binding");
  return binding;
}
const cases = [
  { multi: false, correct: false, method: "applyFlagWrongPenalty" },
  { multi: false, correct: true, method: "applyFlagCorrectScore" },
  { multi: true, correct: false, method: "applyMultiFlagWrongPenalty" },
  { multi: true, correct: true, method: "applyMultiFlagCorrectScore" },
] as const;
function row(jobId: string, problemId: string): DeploymentRecord {
  const b = bindingFixture();
  return {
    ...b,
    jobId,
    problemId,
    status: "COMPLETE",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "alpha",
    namePrefix: "tc-alpha",
    teamLoginKey: "key",
    createdAt: AT,
    updatedAt: AT,
    expiresAt: EXPIRES,
    score: 0,
    stackOutputs: JSON.stringify({ Flag: "answer" }),
  };
}
function shared(repository: DeploymentsRepository, multi: boolean): ParticipantSharedResources {
  const binding = { ...bindingFixture(), jobIds: ["live", "target"] };
  const scoring: ProblemScoringMetadata = multi
    ? {
        kind: "multi-flag",
        flags: [
          { id: "part", label: "Part", flagOutputKey: "Flag", points: 10, wrongAnswerPenalty: 2 },
        ],
      }
    : { kind: "flag", flagOutputKey: "Flag", points: 10, wrongAnswerPenalty: 2 };
  return {
    runtime: {
      resolveDeploymentsRepository: async () => repository,
      resolveEventsRepository: async () => ({
        getEvent: async () => ({ status: "READY", startsAt: "2020-01-01T00:00:00Z" }),
      }),
    },
    mcpTeam: { binding, expiresAt: Date.now() / 1000 + 300, allowSubmit: true },
    problemsScoring: { live: scoring, target: scoring },
    coordinationProblemIds: [],
  } as unknown as ParticipantSharedResources;
}

for (const [backend, create] of Object.entries(backends)) {
  describe(`${backend} flag teardown boundary`, () => {
    for (const [name, mutate] of Object.entries(mutations)) {
      it.each(["DELETING", "DELETED", "EXPIRED", "AUTO_DELETED", "FAILED", "COMPLETE"] as const)(
        `rejects ${name} on teardown %s without changing state`,
        async (status) => {
          const repo = create();
          const record = {
            ...row("target", "target"),
            status,
            ...(["FAILED", "COMPLETE"].includes(status) ? { teardownRequestedAt: AT } : {}),
          };
          await repo.putDeployment(record);
          const before = await repo.getDeployment("target");
          expect((await mutate(repo, "target")).outcome).toBe("conflict");
          expect(await repo.getDeployment("target")).toEqual(before);
        },
      );
      it(`does not recreate missing META for ${name}`, async () => {
        const repo = create();
        expect((await mutate(repo, "missing")).outcome).toBe("conflict");
        expect(await repo.getDeployment("missing")).toBeUndefined();
      });
      it(`allows ordinary FAILED with no teardown for ${name}`, async () => {
        const repo = create();
        await repo.putDeployment({ ...row("target", "target"), status: "FAILED" });
        expect((await mutate(repo, "target")).outcome).toBe("updated");
      });
    }
    for (const { multi, correct, method } of cases) {
      it.each(["deleted", "failed"])(
        `denies actual ${multi ? "multi" : "single"} ${correct ? "correct" : "wrong"} submission mixed with live job after %s teardown`,
        async (state) => {
          const repo = create();
          await repo.putDeployment(row("live", "live"));
          await repo.putDeployment(row("target", "target"));
          if (state === "deleted") await repo.markDeleted("target", AT);
          else {
            await repo.markDeleting("target", row("target", "target").tenantId, AT, EXPIRES);
            await repo.compensateDeleteToFailed(
              "target",
              row("target", "target").tenantId,
              "cleanup failed",
              AT,
              EXPIRES,
            );
          }
          const context = shared(repo, multi);
          expect(await lookupTeamByLoginKey(context, "")).toBeDefined();
          const before = await repo.getDeployment("target");
          expect(
            await submitFlag(
              context,
              context.problemsScoring,
              "",
              "target",
              correct ? "answer" : "wrong",
              "part",
            ),
          ).toEqual({ kind: "unauthorized" });
          expect(await repo.getDeployment("target")).toEqual(before);
          expect(await repo.listScoreEvents("target", { pageSize: 20 })).toEqual([]);
          expect(
            (await submitFlag(context, context.problemsScoring, "", "live", "answer", "part")).kind,
          ).toBe("ok");
        },
      );
      it(`denies a concurrent teardown before the ${multi ? "multi" : "single"} ${correct ? "correct" : "wrong"} write`, async () => {
        const repo = create();
        await repo.putDeployment(row("live", "live"));
        await repo.putDeployment(row("target", "target"));
        const proxy = new Proxy(repo, {
          get(target, prop) {
            if (prop === method)
              return async (...args: unknown[]) => {
                await repo.markDeleting("target", row("target", "target").tenantId, AT, EXPIRES);
                return Reflect.apply(target[method], target, args);
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const context = shared(proxy, multi);
        expect(await lookupTeamByLoginKey(context, "")).toBeDefined();
        expect(
          await submitFlag(
            context,
            context.problemsScoring,
            "",
            "target",
            correct ? "answer" : "wrong",
            "part",
          ),
        ).toEqual({ kind: "unauthorized" });
        expect((await repo.getDeployment("target"))?.score).toBe(0);
        expect(await repo.listScoreEvents("target", { pageSize: 20 })).toEqual([]);
      });
    }
  });
}
