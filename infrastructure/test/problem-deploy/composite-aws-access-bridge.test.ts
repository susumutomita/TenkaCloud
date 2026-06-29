/**
 * [Composite Runtime / Issue #2077] AWS Console + CLI access bridge for a ready
 * composite AWS target.
 *
 * The bridge does NOT re-implement SSO. It resolves a target server-side (team-
 * scoped, via the #2061 repository / GSI3 and the #2076 capability contract),
 * verifies it is a COMPLETE AWS target, then delegates to the proven existing
 * participant Console / CLI functions. Non-AWS targets are rejected as a
 * capability mismatch and STS is never invoked. A cross-team target is
 * indistinguishable from not-found, and the client never supplies a role ARN,
 * account id, or targetDeploymentId as an authority — all of that is resolved
 * from the team-scoped target row.
 *
 * The existing sign-in / CLI functions are INJECTED so these tests run without
 * real AWS STS.
 */

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeDeploymentRepositoryDeps } from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import {
  bridgeCompositeCliCredentials,
  bridgeCompositeConsoleSignin,
  type CompositeAwsAccessBridgeDeps,
} from "../../lib/problem-deploy/handlers/participant-handler/composite-aws-access-bridge";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

const PARENT_ID = "01HPARENTAAAAAAAAAAAAAAAAA";
const TARGET_ID = "01HTARGETXXXXXXXXXXXXXXXXXX";
const TEAM_KEY = "TEAM_LOGIN_KEY_1";

/**
 * A composite target row carrying the full secret / identity surface a COMPLETE
 * AWS target has (competitorRoleArn, externalIdParameterName, stackOutputs with
 * the per-problem ParticipantViewerRoleArn, …). The bridge must resolve all of
 * that server-side and never accept any of it from the client.
 */
const awsTargetRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${TARGET_ID}`,
  SK: "META",
  jobId: TARGET_ID,
  parentDeploymentId: PARENT_ID,
  targetId: "aws-api",
  targetOrdinal: 0,
  tenantId: "tenant-acme",
  problemId: "multicloud-relay",
  runtimeProvider: "aws",
  runtimeEngine: "cloudformation",
  runtimeEntry: "aws/template.yaml",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-multicloud-relay-alpha",
  teamLoginKey: TEAM_KEY,
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-acme/external-id",
  stackOutputs: JSON.stringify({
    ParticipantViewerRoleArn:
      "arn:aws:iam::999999999999:role/tc-multicloud-relay-alpha-participant-viewer",
  }),
  status: "COMPLETE",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:03.000Z",
  expiresAt: 1_800_000_000,
  GSI3PK: `PARENT_DEPLOYMENT#${PARENT_ID}`,
  GSI3SK: "ORDINAL#00#TARGET#aws-api",
  ...over,
});

function buildShared(): ParticipantSharedResources {
  return {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "",
    ddb: { send: vi.fn() } as unknown as ParticipantSharedResources["ddb"],
    ssm: { send: vi.fn() } as unknown as ParticipantSharedResources["ssm"],
    env: "development",
    problemsScoring: {},
    problemsEndpoints: {},
  };
}

/**
 * Wires the repository (GSI3 list + base-table Get) and the injected sign-in /
 * CLI delegates. `ddbSend` answers the QueryCommand (GSI3 parent->target) and the
 * GetCommand (target row) the bridge issues; the SSO delegates are spies so we
 * can assert delegation + that the bridge passes server-resolved identity.
 */
function buildDeps(rows: Array<Record<string, unknown>>): {
  deps: CompositeAwsAccessBridgeDeps;
  repo: CompositeDeploymentRepositoryDeps;
  consoleSignin: ReturnType<typeof vi.fn>;
  cliCredentials: ReturnType<typeof vi.fn>;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) return { Items: rows };
    if (cmd instanceof GetCommand) {
      const pk = String((cmd as GetCommand).input.Key?.PK ?? "");
      return { Item: rows.find((r) => r.PK === pk) };
    }
    return {};
  });
  const repo: CompositeDeploymentRepositoryDeps = {
    ddb: { send: ddbSend } as unknown as CompositeDeploymentRepositoryDeps["ddb"],
    tableName: "TestDeployments",
  };
  const consoleSignin = vi.fn(async () => ({
    kind: "ok",
    loginUrl: "https://signin.example/login",
  }));
  const cliCredentials = vi.fn(async () => ({
    kind: "ok",
    credentials: {
      accessKeyId: "AKIAVIEWER",
      secretAccessKey: "VIEWERSECRET",
      sessionToken: "VIEWERTOKEN",
      expiration: "2026-06-29T01:00:00.000Z",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
    },
  }));
  const deps: CompositeAwsAccessBridgeDeps = {
    repo,
    consoleSignin,
    cliCredentials,
  };
  return { deps, repo, consoleSignin, cliCredentials, ddbSend };
}

const input = (over: Record<string, unknown> = {}) => ({
  teamLoginKey: TEAM_KEY,
  parentDeploymentId: PARENT_ID,
  targetDeploymentId: TARGET_ID,
  ...over,
});

describe("bridgeCompositeConsoleSignin", () => {
  let shared: ParticipantSharedResources;
  beforeEach(() => {
    shared = buildShared();
  });

  it("issues AWS console URL for a ready AWS composite target", async () => {
    const { deps, consoleSignin, cliCredentials } = buildDeps([awsTargetRow()]);

    const out = await bridgeCompositeConsoleSignin(shared, deps, input());

    expect(out).toEqual({ kind: "ok", loginUrl: "https://signin.example/login" });
    // It delegates to the existing console sign-in function exactly once.
    expect(consoleSignin).toHaveBeenCalledOnce();
    expect(cliCredentials).not.toHaveBeenCalled();
    // The delegate is handed the server-resolved teamLoginKey + targetDeploymentId.
    const callArgs = consoleSignin.mock.calls[0] ?? [];
    expect(callArgs[1]).toBe(TEAM_KEY);
    expect(callArgs[2]).toBe(TARGET_ID);
  });

  it("never trusts client-supplied role ARN account id or targetDeploymentId", async () => {
    // The real target lives at TARGET_ID. The client tries to smuggle authority
    // by sending a different targetDeploymentId plus a planted role ARN and
    // account id; the bridge must resolve everything from the row, not the
    // client, so the planted values never reach the delegate and the spoofed
    // target id resolves to not_found (it is not under the parent / team).
    const { deps, consoleSignin } = buildDeps([awsTargetRow()]);

    const out = await bridgeCompositeConsoleSignin(
      shared,
      deps,
      input({
        targetDeploymentId: "01HSPOOFEDxxxxxxxxxxxxxxxx",
        roleArn: "arn:aws:iam::000000000000:role/EvilAdmin",
        awsAccountId: "000000000000",
      }),
    );

    expect(out).toEqual({ kind: "not_found" });
    expect(consoleSignin).not.toHaveBeenCalled();
  });

  it("returns not found for another team target", async () => {
    const { deps, consoleSignin } = buildDeps([
      awsTargetRow({ teamLoginKey: "SOME_OTHER_TEAM_KEY" }),
    ]);

    const out = await bridgeCompositeConsoleSignin(shared, deps, input());

    expect(out).toEqual({ kind: "not_found" });
    expect(consoleSignin).not.toHaveBeenCalled();
  });

  it("returns not ready for a non-complete AWS target", async () => {
    for (const status of ["PENDING", "APPROVAL_PENDING", "IN_PROGRESS", "FAILED"] as const) {
      const { deps, consoleSignin } = buildDeps([awsTargetRow({ status })]);
      const out = await bridgeCompositeConsoleSignin(shared, deps, input());
      expect(out).toEqual({ kind: "not_ready" });
      expect(consoleSignin).not.toHaveBeenCalled();
    }
  });

  it("does not call STS for GCP Azure or Sakura target", async () => {
    for (const provider of ["gcp", "azure", "sakura"] as const) {
      const { deps, consoleSignin, cliCredentials } = buildDeps([
        awsTargetRow({ runtimeProvider: provider, targetId: provider }),
      ]);
      const out = await bridgeCompositeConsoleSignin(shared, deps, input());
      expect(out).toEqual({ kind: "capability_mismatch", provider });
      // The bridge never reaches the AWS sign-in delegate (= no STS).
      expect(consoleSignin).not.toHaveBeenCalled();
      expect(cliCredentials).not.toHaveBeenCalled();
    }
  });

  it("rejects an unsupported provider as a capability mismatch", async () => {
    const { deps, consoleSignin } = buildDeps([
      awsTargetRow({ runtimeProvider: "oracle", targetId: "oracle" }),
    ]);
    const out = await bridgeCompositeConsoleSignin(shared, deps, input());
    expect(out).toEqual({ kind: "capability_mismatch", provider: "unsupported" });
    expect(consoleSignin).not.toHaveBeenCalled();
  });
});

describe("bridgeCompositeCliCredentials", () => {
  let shared: ParticipantSharedResources;
  beforeEach(() => {
    shared = buildShared();
  });

  it("issues AWS CLI credentials for a ready AWS composite target", async () => {
    const { deps, cliCredentials, consoleSignin } = buildDeps([awsTargetRow()]);

    const out = await bridgeCompositeCliCredentials(shared, deps, input());

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.credentials.accessKeyId).toBe("AKIAVIEWER");
    expect(out.credentials.region).toBe("ap-northeast-1");
    expect(cliCredentials).toHaveBeenCalledOnce();
    expect(consoleSignin).not.toHaveBeenCalled();
    const callArgs = cliCredentials.mock.calls[0] ?? [];
    expect(callArgs[1]).toBe(TEAM_KEY);
    expect(callArgs[2]).toBe(TARGET_ID);
  });

  it("does not call STS for GCP Azure or Sakura target", async () => {
    for (const provider of ["gcp", "azure", "sakura"] as const) {
      const { deps, cliCredentials } = buildDeps([
        awsTargetRow({ runtimeProvider: provider, targetId: provider }),
      ]);
      const out = await bridgeCompositeCliCredentials(shared, deps, input());
      expect(out).toEqual({ kind: "capability_mismatch", provider });
      expect(cliCredentials).not.toHaveBeenCalled();
    }
  });

  it("returns not ready for a non-complete AWS target", async () => {
    const { deps, cliCredentials } = buildDeps([awsTargetRow({ status: "IN_PROGRESS" })]);
    const out = await bridgeCompositeCliCredentials(shared, deps, input());
    expect(out).toEqual({ kind: "not_ready" });
    expect(cliCredentials).not.toHaveBeenCalled();
  });

  it("returns not found for another team target", async () => {
    const { deps, cliCredentials } = buildDeps([
      awsTargetRow({ teamLoginKey: "SOME_OTHER_TEAM_KEY" }),
    ]);
    const out = await bridgeCompositeCliCredentials(shared, deps, input());
    expect(out).toEqual({ kind: "not_found" });
    expect(cliCredentials).not.toHaveBeenCalled();
  });

  it("never trusts client-supplied role ARN account id or targetDeploymentId", async () => {
    const { deps, cliCredentials } = buildDeps([awsTargetRow()]);
    const out = await bridgeCompositeCliCredentials(
      shared,
      deps,
      input({
        targetDeploymentId: "01HSPOOFEDxxxxxxxxxxxxxxxx",
        roleArn: "arn:aws:iam::000000000000:role/EvilAdmin",
      }),
    );
    expect(out).toEqual({ kind: "not_found" });
    expect(cliCredentials).not.toHaveBeenCalled();
  });
});

describe("composite AWS access bridge: delegate resolves the server-side target row", () => {
  it("hands the delegate a loader that returns the GSI3-resolved AWS target row", async () => {
    // The bridge must not let the delegate re-query GSI2 (composite targets are
    // intentionally absent there). Instead it injects a loader returning the
    // server-resolved row, so the existing SSO validation + AssumeRole chain runs
    // against the true target. We capture that loader and assert it returns the
    // resolved row for the resolved (teamLoginKey, targetDeploymentId).
    const shared = buildShared();
    const { deps } = buildDeps([awsTargetRow()]);

    let capturedLoader: ((s: unknown, key: string, jobId: string) => Promise<unknown>) | undefined;
    const consoleSignin = vi.fn(
      async (
        _shared: unknown,
        _key: string,
        _jobId: string,
        d?: { loadDeployment?: (s: unknown, key: string, jobId: string) => Promise<unknown> },
      ) => {
        capturedLoader = d?.loadDeployment;
        return { kind: "ok", loginUrl: "https://signin.example/login" };
      },
    );

    await bridgeCompositeConsoleSignin(shared, { ...deps, consoleSignin }, input());

    expect(capturedLoader).toBeTypeOf("function");
    const loaded = (await capturedLoader?.(shared, TEAM_KEY, TARGET_ID)) as { jobId?: string };
    expect(loaded?.jobId).toBe(TARGET_ID);
  });
});
