import {
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  handleDeleteTeamCredential,
  handleGetTeamCredentialStatus,
  handleRegisterTeamCredential,
  isTeamCredentialProvider,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/team-credentials-routes.js";

/**
 * [#1413] per-team cloud credential onboarding routes の振る舞い pin。 provider 別 Zod 検証 /
 * store への SecureString Put / status は secret を echo しない / 不正 body は 400 / delete idempotent。
 */

function deps(send: ReturnType<typeof vi.fn>) {
  return { shared: { ssm: { send } as never, env: "development" } };
}

function putCommands(send: ReturnType<typeof vi.fn>): PutParameterCommand[] {
  return send.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is PutParameterCommand => cmd instanceof PutParameterCommand);
}

/** SSM Parameter Store の in-memory 版。 GetParametersByPath は実物と同じく 1 page 10 件で返す。 */
function fakeParameterStore(names: readonly string[]) {
  const params = new Map(names.map((name) => [name, "stored"]));
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetParameterCommand) {
      const value = params.get(String(cmd.input.Name));
      if (value === undefined) throw new ParameterNotFound({ message: "x", $metadata: {} });
      return { Parameter: { Name: cmd.input.Name, Value: value } };
    }
    if (cmd instanceof PutParameterCommand) {
      params.set(String(cmd.input.Name), String(cmd.input.Value));
      return {};
    }
    if (cmd instanceof GetParametersByPathCommand) {
      const under = [...params.keys()].filter((n) => n.startsWith(`${cmd.input.Path}/`)).sort();
      const start = Number(cmd.input.NextToken ?? 0);
      const next = start + 10 < under.length ? String(start + 10) : undefined;
      return {
        Parameters: under.slice(start, start + 10).map((Name) => ({ Name })),
        NextToken: next,
      };
    }
    throw new Error("unexpected SSM command");
  });
  return { send, params };
}

const teamNames = (tenantId: string, count: number, suffix = "sakura-api-key") =>
  Array.from(
    { length: count },
    (_, i) => `/development/tenants/${tenantId}/teams/team-${i}/${suffix}`,
  );

const SAKURA = { accessToken: "tok", accessTokenSecret: "sec" };
const AZURE = {
  azureTenantId: "dir",
  clientId: "app",
  clientSecret: "shh",
  subscriptionId: "sub",
  resourceGroup: "rg",
};
const GCP = {
  wifAudience: "//iam.googleapis.com/x/providers/aws",
  serviceAccountEmail: "d@p.iam.gserviceaccount.com",
  projectId: "proj",
  location: "asia-northeast1",
};

describe("team-credentials-routes (#1413)", () => {
  it("should recognize only sakura/azure/gcp as valid providers", () => {
    expect(isTeamCredentialProvider("sakura")).toBe(true);
    expect(isTeamCredentialProvider("azure")).toBe(true);
    expect(isTeamCredentialProvider("gcp")).toBe(true);
    expect(isTeamCredentialProvider("aws")).toBe(false);
    expect(isTeamCredentialProvider("nope")).toBe(false);
  });

  it("should register a sakura credential as a SecureString at the per-team path", async () => {
    const send = vi.fn().mockResolvedValue({});
    const res = await handleRegisterTeamCredential(deps(send), "sakura", "t1", "team-a", SAKURA);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ registered: true, provider: "sakura", teamSlug: "team-a" });
    const [cmd] = putCommands(send);
    expect(cmd.input.Name).toBe("/development/tenants/t1/teams/team-a/sakura-api-key");
    expect(cmd.input.Type).toBe("SecureString");
  });

  it("should register azure + gcp credentials at their own paths", async () => {
    const sendA = vi.fn().mockResolvedValue({});
    await handleRegisterTeamCredential(deps(sendA), "azure", "t1", "team-a", AZURE);
    expect(putCommands(sendA)[0].input.Name).toBe(
      "/development/tenants/t1/teams/team-a/azure-credential",
    );
    const sendG = vi.fn().mockResolvedValue({});
    await handleRegisterTeamCredential(deps(sendG), "gcp", "t1", "team-a", GCP);
    expect(putCommands(sendG)[0].input.Name).toBe(
      "/development/tenants/t1/teams/team-a/gcp-credential",
    );
  });

  it("accepts an optional GCP artifact bucket without echoing it and retains strict validation", async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await handleRegisterTeamCredential(deps(send), "gcp", "t1", "team-a", {
      ...GCP,
      artifactBucket: "fixture-team-blueprints",
    });
    expect(result.status).toBe(201);
    expect(JSON.parse(String(putCommands(send)[0].input.Value))).toEqual({
      ...GCP,
      artifactBucket: "fixture-team-blueprints",
    });
    expect(JSON.stringify(result.body)).not.toContain("fixture-team-blueprints");
    const invalid = vi.fn();
    for (const artifactBucket of ["", 42, null]) {
      const response = await handleRegisterTeamCredential(deps(invalid), "gcp", "t1", "team-a", {
        ...GCP,
        artifactBucket,
      });
      expect(response.status).toBe(400);
    }
    const extra = await handleRegisterTeamCredential(deps(invalid), "gcp", "t1", "team-a", {
      ...GCP,
      artifactBucket: "fixture",
      injected: true,
    });
    expect(extra.status).toBe(400);
    expect(invalid).not.toHaveBeenCalled();
  });

  it("should reject an invalid / incomplete body with 400 and never Put", async () => {
    const send = vi.fn().mockResolvedValue({});
    const res = await handleRegisterTeamCredential(
      deps(send),
      "sakura",
      "t1",
      "team-a",
      { accessToken: "only" }, // missing accessTokenSecret
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("validation_failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("should reject unknown extra fields (strict schema)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const res = await handleRegisterTeamCredential(deps(send), "sakura", "t1", "team-a", {
      ...SAKURA,
      injected: "x",
    });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("should report registered=true WITHOUT echoing the secret in status", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(SAKURA) } });
    const res = await handleGetTeamCredentialStatus(deps(send), "sakura", "t1", "team-a");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ provider: "sakura", teamSlug: "team-a", registered: true });
    // secret は body に絶対出さない
    expect(JSON.stringify(res.body)).not.toContain("sec");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetParameterCommand);
  });

  it("should report registered=false when the credential is absent", async () => {
    const send = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    const res = await handleGetTeamCredentialStatus(deps(send), "azure", "t1", "team-a");
    expect(res.body).toEqual({ provider: "azure", teamSlug: "team-a", registered: false });
  });

  it("should delete the credential idempotently", async () => {
    const send = vi.fn().mockResolvedValue({});
    const res = await handleDeleteTeamCredential(deps(send), "gcp", "t1", "team-a");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, provider: "gcp", teamSlug: "team-a" });
  });
});

describe("team credential limit per tenant (#3290)", () => {
  it("should register a new team while the tenant is under the limit", async () => {
    const ssm = fakeParameterStore(teamNames("t1", 98));
    const res = await handleRegisterTeamCredential(deps(ssm.send), "sakura", "t1", "new", SAKURA);
    expect(res.status).toBe(201);
    expect(ssm.params.has("/development/tenants/t1/teams/new/sakura-api-key")).toBe(true);
  });

  it("should refuse a new team once the tenant holds 99 credentials of that provider", async () => {
    const ssm = fakeParameterStore(teamNames("t1", 99, "gcp-credential"));
    const res = await handleRegisterTeamCredential(deps(ssm.send), "gcp", "t1", "new", GCP);
    expect(res).toEqual({
      status: 409,
      body: { error: "team_credential_limit_reached", limit: 99 },
    });
    expect(putCommands(ssm.send)).toEqual([]);
    expect(ssm.params.size).toBe(99);
  });

  it("should count each provider separately so a composite event can use all of them", async () => {
    const names = [
      ...teamNames("t1", 99),
      ...teamNames("t1", 99, "gcp-credential"),
      ...teamNames("t1", 98, "azure-credential"),
    ];
    const ssm = fakeParameterStore(names);
    const res = await handleRegisterTeamCredential(deps(ssm.send), "azure", "t1", "team-98", AZURE);
    expect(res.status).toBe(201);
    expect(ssm.params.size).toBe(297);
  });

  it("should still overwrite an existing team at the limit (rotation)", async () => {
    const ssm = fakeParameterStore(teamNames("t1", 99));
    const res = await handleRegisterTeamCredential(
      deps(ssm.send),
      "sakura",
      "t1",
      "team-7",
      SAKURA,
    );
    expect(res.status).toBe(201);
    expect(ssm.params.get("/development/tenants/t1/teams/team-7/sakura-api-key")).toBe(
      JSON.stringify(SAKURA),
    );
    expect(ssm.params.size).toBe(99);
  });

  it("should not count another tenant's credentials", async () => {
    const ssm = fakeParameterStore(teamNames("t2", 99));
    const res = await handleRegisterTeamCredential(deps(ssm.send), "sakura", "t1", "new", SAKURA);
    expect(res.status).toBe(201);
  });

  it("should stop listing after the pages that reach the limit", async () => {
    const ssm = fakeParameterStore(teamNames("t1", 150));
    const res = await handleRegisterTeamCredential(deps(ssm.send), "sakura", "t1", "new", SAKURA);
    expect(res.status).toBe(409);
    const listings = ssm.send.mock.calls.filter(
      ([cmd]) => cmd instanceof GetParametersByPathCommand,
    );
    expect(listings).toHaveLength(10);
  });
});
