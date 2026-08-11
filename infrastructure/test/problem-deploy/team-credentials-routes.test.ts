import { GetParameterCommand, ParameterNotFound, PutParameterCommand } from "@aws-sdk/client-ssm";
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
    const cmd = send.mock.calls[0][0] as PutParameterCommand;
    expect(cmd).toBeInstanceOf(PutParameterCommand);
    expect(cmd.input.Name).toBe("/development/tenants/t1/teams/team-a/sakura-api-key");
    expect(cmd.input.Type).toBe("SecureString");
  });

  it("should register azure + gcp credentials at their own paths", async () => {
    const sendA = vi.fn().mockResolvedValue({});
    await handleRegisterTeamCredential(deps(sendA), "azure", "t1", "team-a", AZURE);
    expect((sendA.mock.calls[0][0] as PutParameterCommand).input.Name).toBe(
      "/development/tenants/t1/teams/team-a/azure-credential",
    );
    const sendG = vi.fn().mockResolvedValue({});
    await handleRegisterTeamCredential(deps(sendG), "gcp", "t1", "team-a", GCP);
    expect((sendG.mock.calls[0][0] as PutParameterCommand).input.Name).toBe(
      "/development/tenants/t1/teams/team-a/gcp-credential",
    );
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
