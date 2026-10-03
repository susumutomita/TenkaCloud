/**
 * [Composite Runtime / Issue #2065] Tests for the provider-neutral composite
 * target connection resolver.
 *
 * Drives the REAL collaborators (the verified competitor-account lookup + the
 * per-team SecureString stores) through small in-memory DynamoDB / SSM fakes, so
 * the structural validity check and the AWS trust gate are actually exercised —
 * not mocked away.
 */

import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CompositeTargetConnectionDeps,
  MissingTargetConnectionError,
  resolveCompositeTargetConnection,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-connection";
import { UnverifiedCompetitorAccountError } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { buildAzureCredentialParameterName } from "../../lib/problem-deploy/handlers/shared/azure-credential-store";
import { buildGcpCredentialParameterName } from "../../lib/problem-deploy/handlers/shared/gcp-credential-store";
import { buildSakuraCredentialParameterName } from "../../lib/problem-deploy/handlers/shared/sakura-credential-store";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const ENV = "test";
const TENANT = "tenant-acme";
const TEAM = "alpha";

const VALID_GCP = {
  wifAudience:
    "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
  serviceAccountEmail: "deploy@p.iam.gserviceaccount.com",
  projectId: "proj-1",
  location: "asia-northeast1",
};
const AZURE_SECRET = "AZURE-CLIENT-SECRET-DO-NOT-LEAK";
const VALID_AZURE = {
  azureTenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: AZURE_SECRET,
  subscriptionId: "33333333-3333-3333-3333-333333333333",
  resourceGroup: "rg-deploy",
};
const SAKURA_SECRET = "SAKURA-TOKEN-SECRET-DO-NOT-LEAK";
const VALID_SAKURA = { accessToken: "sakura-token", accessTokenSecret: SAKURA_SECRET };

function parameterNotFound(): Error & { name: string } {
  const err = new Error("parameter not found") as Error & { name: string };
  err.name = "ParameterNotFound";
  return err;
}

function makeFakeSsm(params: Record<string, string> = {}) {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetParameterCommand) {
      const name = cmd.input.Name as string;
      const value = params[name];
      if (value === undefined) throw parameterNotFound();
      return { Parameter: { Value: value } };
    }
    throw new Error("unexpected ssm command");
  });
  return { send };
}

function makeFakeDdb(account?: {
  verified: boolean;
  competitorRoleName?: string;
  region?: string;
}) {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      return {
        Item: account
          ? {
              verified: account.verified,
              competitorRoleName: account.competitorRoleName ?? "TenkaCloudCompetitorRole",
              region: account.region ?? "ap-northeast-1",
            }
          : undefined,
      };
    }
    throw new Error("unexpected ddb command");
  });
  return { send };
}

function makeDeps(
  ddb: { send: ReturnType<typeof vi.fn> },
  ssm: { send: ReturnType<typeof vi.fn> },
): CompositeTargetConnectionDeps {
  return {
    aws: {
      runtime: makeTestControlDataRuntime(),
      ddb: { send: ddb.send },
      competitorAccountsTableName: "CompetitorAccounts",
      env: ENV,
    },
    credentials: { ssm: { send: ssm.send }, env: ENV },
  };
}

describe("resolveCompositeTargetConnection (#2065)", () => {
  it("resolves an AWS target through the verified account lookup", async () => {
    const ddb = makeFakeDdb({ verified: true, region: "ap-northeast-1" });
    const ssm = makeFakeSsm();
    const conn = await resolveCompositeTargetConnection(makeDeps(ddb, ssm), {
      provider: "aws",
      tenantId: TENANT,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
    });
    expect(conn).toEqual({
      provider: "aws",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloudCompetitorRole",
      externalIdParameterName: `/${ENV}/tenants/${TENANT}/external-id`,
    });
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it("resolves a GCP target from valid WIF configuration without AWS lookup", async () => {
    const ddb = makeFakeDdb();
    const ssm = makeFakeSsm({
      [buildGcpCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_GCP),
    });
    const conn = await resolveCompositeTargetConnection(makeDeps(ddb, ssm), {
      provider: "gcp",
      tenantId: TENANT,
      teamSlug: TEAM,
    });
    expect(conn).toEqual({ provider: "gcp", teamSlug: TEAM });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("resolves an Azure target from valid configuration without AWS lookup", async () => {
    const ddb = makeFakeDdb();
    const ssm = makeFakeSsm({
      [buildAzureCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_AZURE),
    });
    const conn = await resolveCompositeTargetConnection(makeDeps(ddb, ssm), {
      provider: "azure",
      tenantId: TENANT,
      teamSlug: TEAM,
    });
    expect(conn).toEqual({ provider: "azure", teamSlug: TEAM });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("resolves a Sakura target from valid configuration without AWS lookup", async () => {
    const ddb = makeFakeDdb();
    const ssm = makeFakeSsm({
      [buildSakuraCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_SAKURA),
    });
    const conn = await resolveCompositeTargetConnection(makeDeps(ddb, ssm), {
      provider: "sakura",
      tenantId: TENANT,
      teamSlug: TEAM,
    });
    expect(conn).toEqual({ provider: "sakura", teamSlug: TEAM });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("rejects missing GCP configuration before dispatch", async () => {
    const deps = makeDeps(makeFakeDdb(), makeFakeSsm());
    await expect(
      resolveCompositeTargetConnection(deps, { provider: "gcp", tenantId: TENANT, teamSlug: TEAM }),
    ).rejects.toBeInstanceOf(MissingTargetConnectionError);
  });

  it("rejects missing Azure configuration before dispatch", async () => {
    const deps = makeDeps(makeFakeDdb(), makeFakeSsm());
    await expect(
      resolveCompositeTargetConnection(deps, {
        provider: "azure",
        tenantId: TENANT,
        teamSlug: TEAM,
      }),
    ).rejects.toBeInstanceOf(MissingTargetConnectionError);
  });

  it("rejects missing Sakura configuration before dispatch", async () => {
    const deps = makeDeps(makeFakeDdb(), makeFakeSsm());
    await expect(
      resolveCompositeTargetConnection(deps, {
        provider: "sakura",
        tenantId: TENANT,
        teamSlug: TEAM,
      }),
    ).rejects.toBeInstanceOf(MissingTargetConnectionError);
  });

  it("rejects a structurally invalid (malformed) non-AWS configuration", async () => {
    // Missing required fields → the store's fail-closed parser returns undefined.
    const ssm = makeFakeSsm({
      [buildGcpCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify({ projectId: "p" }),
    });
    await expect(
      resolveCompositeTargetConnection(makeDeps(makeFakeDdb(), ssm), {
        provider: "gcp",
        tenantId: TENANT,
        teamSlug: TEAM,
      }),
    ).rejects.toBeInstanceOf(MissingTargetConnectionError);
  });

  it("supports an Azure and Sakura composite without AWS input", async () => {
    const ddb = makeFakeDdb();
    const ssm = makeFakeSsm({
      [buildAzureCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_AZURE),
      [buildSakuraCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_SAKURA),
    });
    const deps = makeDeps(ddb, ssm);
    const azure = await resolveCompositeTargetConnection(deps, {
      provider: "azure",
      tenantId: TENANT,
      teamSlug: TEAM,
    });
    const sakura = await resolveCompositeTargetConnection(deps, {
      provider: "sakura",
      tenantId: TENANT,
      teamSlug: TEAM,
    });
    expect(azure).toEqual({ provider: "azure", teamSlug: TEAM });
    expect(sakura).toEqual({ provider: "sakura", teamSlug: TEAM });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("never returns a secret or access token", async () => {
    const ssm = makeFakeSsm({
      [buildAzureCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_AZURE),
      [buildSakuraCredentialParameterName(ENV, TENANT, TEAM)]: JSON.stringify(VALID_SAKURA),
    });
    const deps = makeDeps(makeFakeDdb(), ssm);
    for (const provider of ["azure", "sakura"] as const) {
      const conn = await resolveCompositeTargetConnection(deps, {
        provider,
        tenantId: TENANT,
        teamSlug: TEAM,
      });
      expect(Object.keys(conn).sort()).toEqual(["provider", "teamSlug"]);
      const serialized = JSON.stringify(conn);
      expect(serialized).not.toContain(AZURE_SECRET);
      expect(serialized).not.toContain(SAKURA_SECRET);
    }
  });

  it("does not change legacy single-provider account gate behavior", async () => {
    // Unverified row → existing domain error (same as legacy startDeployment).
    const unverified = makeDeps(makeFakeDdb({ verified: false }), makeFakeSsm());
    await expect(
      resolveCompositeTargetConnection(unverified, {
        provider: "aws",
        tenantId: TENANT,
        awsAccountId: "123456789012",
        region: "ap-northeast-1",
      }),
    ).rejects.toBeInstanceOf(UnverifiedCompetitorAccountError);

    // Missing row → same domain error.
    const missing = makeDeps(makeFakeDdb(), makeFakeSsm());
    await expect(
      resolveCompositeTargetConnection(missing, {
        provider: "aws",
        tenantId: TENANT,
        awsAccountId: "999999999999",
        region: "ap-northeast-1",
      }),
    ).rejects.toBeInstanceOf(UnverifiedCompetitorAccountError);
  });
});
