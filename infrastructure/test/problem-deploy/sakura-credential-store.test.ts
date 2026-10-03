import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  ParameterType,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  buildSakuraCredentialParameterArnPattern,
  buildSakuraCredentialParameterName,
  deleteSakuraCredential,
  getSakuraCredential,
  putSakuraCredential,
  type SakuraCredentialStoreDeps,
} from "../../lib/problem-deploy/handlers/shared/sakura-credential-store.js";

/**
 * [#1412] per-team Sakura API-key store の振る舞い pin。 SSM を mock し、 path 規約 /
 * SecureString 保管 / fail-safe parse / not-found→undefined / idempotent delete を観測する。
 */

function makeDeps(send: ReturnType<typeof vi.fn>): SakuraCredentialStoreDeps {
  return { ssm: { send } as never, env: "development" };
}

const CRED = { accessToken: "tok-abc", accessTokenSecret: "sec-xyz" };

describe("sakura-credential-store (#1412)", () => {
  it("should build a per-team SecureString path nested under tenant + team", () => {
    expect(buildSakuraCredentialParameterName("development", "tenant-1", "team-a")).toBe(
      "/development/tenants/tenant-1/teams/team-a/sakura-api-key",
    );
  });

  it("should build an IAM ARN pattern wildcarding tenantId + teamSlug", () => {
    expect(
      buildSakuraCredentialParameterArnPattern("ap-northeast-1", "123456789012", "production"),
    ).toBe(
      "arn:aws:ssm:ap-northeast-1:123456789012:parameter/production/tenants/*/teams/*/sakura-api-key",
    );
  });

  it("should get + decrypt the credential and parse the stored JSON", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(CRED) } });
    const got = await getSakuraCredential(makeDeps(send), "tenant-1", "team-a");
    expect(got).toEqual(CRED);
    const cmd = send.mock.calls[0][0] as GetParameterCommand;
    expect(cmd).toBeInstanceOf(GetParameterCommand);
    expect(cmd.input).toEqual({
      Name: "/development/tenants/tenant-1/teams/team-a/sakura-api-key",
      WithDecryption: true,
    });
  });

  it("should return undefined when the parameter is not found (fail-closed)", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ParameterNotFound({ message: "nope", $metadata: {} }));
    expect(await getSakuraCredential(makeDeps(send), "tenant-1", "team-a")).toBeUndefined();
  });

  it("should treat a name-based ParameterNotFound the same as the class instance", async () => {
    const err = Object.assign(new Error("nope"), { name: "ParameterNotFound" });
    const send = vi.fn().mockRejectedValue(err);
    expect(await getSakuraCredential(makeDeps(send), "tenant-1", "team-a")).toBeUndefined();
  });

  it("should return undefined for malformed JSON, non-object, or missing fields (fail-safe parse)", async () => {
    for (const value of [
      "not json",
      "[1,2,3]",
      JSON.stringify({ accessToken: "only-token" }),
      JSON.stringify({ accessToken: "", accessTokenSecret: "x" }),
      JSON.stringify({ accessToken: 1, accessTokenSecret: 2 }),
      "null",
    ]) {
      const send = vi.fn().mockResolvedValue({ Parameter: { Value: value } });
      expect(await getSakuraCredential(makeDeps(send), "t", "team")).toBeUndefined();
    }
  });

  it("should return undefined when the parameter has no value", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: {} });
    expect(await getSakuraCredential(makeDeps(send), "t", "team")).toBeUndefined();
  });

  it("should rethrow non-not-found errors from get", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(getSakuraCredential(makeDeps(send), "t", "team")).rejects.toThrow("throttled");
  });

  it("should put the credential as a SecureString JSON with Overwrite for rotation", async () => {
    const send = vi.fn().mockResolvedValue({});
    await putSakuraCredential(makeDeps(send), "tenant-1", "team-a", CRED);
    const cmd = send.mock.calls[0][0] as PutParameterCommand;
    expect(cmd).toBeInstanceOf(PutParameterCommand);
    expect(cmd.input.Name).toBe("/development/tenants/tenant-1/teams/team-a/sakura-api-key");
    expect(cmd.input.Type).toBe(ParameterType.SECURE_STRING);
    expect(cmd.input.Overwrite).toBe(true);
    expect(JSON.parse(cmd.input.Value as string)).toEqual(CRED);
  });

  it("should round-trip a put then get to the same credential", async () => {
    let stored: string | undefined;
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd instanceof PutParameterCommand) {
        stored = cmd.input.Value as string;
        return Promise.resolve({});
      }
      return Promise.resolve({ Parameter: { Value: stored } });
    });
    const deps = makeDeps(send);
    await putSakuraCredential(deps, "t", "team", CRED);
    expect(await getSakuraCredential(deps, "t", "team")).toEqual(CRED);
  });

  it("should delete the parameter by the per-team path", async () => {
    const send = vi.fn().mockResolvedValue({});
    await deleteSakuraCredential(makeDeps(send), "tenant-1", "team-a");
    const cmd = send.mock.calls[0][0] as DeleteParameterCommand;
    expect(cmd).toBeInstanceOf(DeleteParameterCommand);
    expect(cmd.input.Name).toBe("/development/tenants/tenant-1/teams/team-a/sakura-api-key");
  });

  it("should treat delete of a missing parameter as a no-op (idempotent)", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ParameterNotFound({ message: "nope", $metadata: {} }));
    await expect(deleteSakuraCredential(makeDeps(send), "t", "team")).resolves.toBeUndefined();
  });

  it("should rethrow non-not-found errors from delete", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access denied"));
    await expect(deleteSakuraCredential(makeDeps(send), "t", "team")).rejects.toThrow(
      "access denied",
    );
  });
});
