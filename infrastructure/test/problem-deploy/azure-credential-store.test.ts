import {
  type GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  type AzureCredentialStoreDeps,
  buildAzureCredentialParameterArnPattern,
  buildAzureCredentialParameterName,
  deleteAzureCredential,
  getAzureCredential,
  putAzureCredential,
} from "../../lib/problem-deploy/handlers/shared/azure-credential-store.js";

/**
 * [#1410] per-team Azure deploy credential store の振る舞い pin。 path 規約 / 必須 field の
 * fail-safe parse / round-trip / not-found→undefined / idempotent delete を観測する (SSM mock)。
 */

function makeDeps(send: ReturnType<typeof vi.fn>): AzureCredentialStoreDeps {
  return { ssm: { send } as never, env: "development" };
}

const CRED = {
  azureTenantId: "dir-1",
  clientId: "app-1",
  clientSecret: "shh",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  location: "japaneast",
};

describe("azure-credential-store (#1410)", () => {
  it("should build a per-team SecureString path + IAM ARN pattern", () => {
    expect(buildAzureCredentialParameterName("development", "t1", "team-a")).toBe(
      "/development/tenants/t1/teams/team-a/azure-credential",
    );
    expect(
      buildAzureCredentialParameterArnPattern("ap-northeast-1", "123456789012", "production"),
    ).toBe(
      "arn:aws:ssm:ap-northeast-1:123456789012:parameter/production/tenants/*/teams/*/azure-credential",
    );
  });

  it("should get + decrypt + parse the full deploy config", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(CRED) } });
    expect(await getAzureCredential(makeDeps(send), "t1", "team-a")).toEqual(CRED);
    const cmd = send.mock.calls[0][0] as GetParameterCommand;
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it("should accept config without the optional location", async () => {
    const { location: _omit, ...noLoc } = CRED;
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(noLoc) } });
    expect(await getAzureCredential(makeDeps(send), "t1", "team-a")).toEqual(noLoc);
  });

  it("should return undefined when a required field is missing or malformed (fail-safe)", async () => {
    for (const value of [
      "not json",
      JSON.stringify({ ...CRED, clientSecret: undefined }),
      JSON.stringify({ ...CRED, subscriptionId: "" }),
      JSON.stringify({ ...CRED, location: 123 }),
      "null",
    ]) {
      const send = vi.fn().mockResolvedValue({ Parameter: { Value: value } });
      expect(await getAzureCredential(makeDeps(send), "t", "team")).toBeUndefined();
    }
  });

  it("should return undefined on ParameterNotFound (fail-closed)", async () => {
    const send = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect(await getAzureCredential(makeDeps(send), "t", "team")).toBeUndefined();
  });

  it("should put as a SecureString and round-trip", async () => {
    let stored: string | undefined;
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof PutParameterCommand) {
        stored = cmd.input.Value as string;
        expect(cmd.input.Type).toBe("SecureString");
        expect(cmd.input.Overwrite).toBe(true);
        return Promise.resolve({});
      }
      return Promise.resolve({ Parameter: { Value: stored } });
    });
    const deps = makeDeps(send);
    await putAzureCredential(deps, "t", "team", CRED);
    expect(await getAzureCredential(deps, "t", "team")).toEqual(CRED);
  });

  it("should treat delete of a missing parameter as a no-op (idempotent)", async () => {
    const send = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    await expect(deleteAzureCredential(makeDeps(send), "t", "team")).resolves.toBeUndefined();
  });
});
