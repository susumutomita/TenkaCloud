import {
  type GetParameterCommand,
  type GetParametersByPathCommand,
  ParameterNotFound,
  type PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  buildTenantTeamsPathArnPattern,
  countTenantTeamParameters,
  createSecureJsonStore,
  secureParameterExists,
} from "../../lib/problem-deploy/handlers/shared/secure-json-store.js";

/**
 * [#1412 #1410] 汎用 SecureJsonStore の契約 pin (Sakura / Azure store が共有する DRY 基盤)。
 * buildName / parse / serialize の注入が正しく get/put/delete に反映され、 not-found→undefined +
 * idempotent delete + parse 委譲が成り立つことを観測する。
 */

interface Demo {
  readonly a: string;
}

const store = createSecureJsonStore<Demo>({
  buildName: (env, t, s) => `/${env}/x/${t}/${s}/demo`,
  parse: (raw) => {
    if (typeof raw !== "string") return undefined;
    try {
      const o = JSON.parse(raw) as { a?: unknown };
      return typeof o.a === "string" ? { a: o.a } : undefined;
    } catch {
      return undefined;
    }
  },
  serialize: (v) => JSON.stringify(v),
});

const deps = (send: ReturnType<typeof vi.fn>) => ({ ssm: { send } as never, env: "dev" });

describe("secure-json-store (shared)", () => {
  it("should GET with decryption at the built path and delegate to parse", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify({ a: "hi" }) } });
    expect(await store.get(deps(send), "t1", "team")).toEqual({ a: "hi" });
    const cmd = send.mock.calls[0][0] as GetParameterCommand;
    expect(cmd.input).toEqual({ Name: "/dev/x/t1/team/demo", WithDecryption: true });
  });

  it("should return undefined when parse rejects the stored value", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify({ a: 1 }) } });
    expect(await store.get(deps(send), "t1", "team")).toBeUndefined();
  });

  it("should return undefined on ParameterNotFound (fail-closed)", async () => {
    const send = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect(await store.get(deps(send), "t", "team")).toBeUndefined();
  });

  it("should PUT as a SecureString with Overwrite, serialized", async () => {
    const send = vi.fn().mockResolvedValue({});
    await store.put(deps(send), "t", "team", { a: "v" });
    const cmd = send.mock.calls[0][0] as PutParameterCommand;
    expect(cmd.input.Type).toBe("SecureString");
    expect(cmd.input.Overwrite).toBe(true);
    expect(cmd.input.Value).toBe(JSON.stringify({ a: "v" }));
  });

  it("should treat delete of a missing parameter as idempotent and rethrow other errors", async () => {
    const gone = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    await expect(store.delete(deps(gone), "t", "team")).resolves.toBeUndefined();
    const boom = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(store.delete(deps(boom), "t", "team")).rejects.toThrow("denied");
  });
});

describe("tenant team parameters (#3290)", () => {
  const pageOf = (n: number, nextToken?: string) => ({
    Parameters: Array.from({ length: n }, (_, i) => ({ Name: `/dev/tenants/t1/teams/s${i}/x` })),
    NextToken: nextToken,
  });

  it("should report a parameter as existing without decrypting it", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Name: "/p", Value: "not json" } });
    expect(await secureParameterExists(deps(send), "/p")).toBe(true);
    expect((send.mock.calls[0][0] as GetParameterCommand).input).toEqual({
      Name: "/p",
      WithDecryption: false,
    });
  });

  it("should report a missing parameter as absent and rethrow other errors", async () => {
    const gone = vi.fn().mockRejectedValue(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect(await secureParameterExists(deps(gone), "/p")).toBe(false);
    expect(await secureParameterExists(deps(vi.fn().mockResolvedValue({})), "/p")).toBe(false);
    const boom = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(secureParameterExists(deps(boom), "/p")).rejects.toThrow("throttled");
  });

  it("should count every page under the tenant's teams path without decrypting", async () => {
    const send = vi.fn().mockResolvedValueOnce(pageOf(10, "p2")).mockResolvedValueOnce(pageOf(3));
    expect(await countTenantTeamParameters(deps(send), "t1", "/x", 99)).toBe(13);
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0][0] as GetParametersByPathCommand).input;
    expect(first).toEqual({
      Path: "/dev/tenants/t1/teams",
      Recursive: true,
      WithDecryption: false,
      NextToken: undefined,
    });
    expect((send.mock.calls[1][0] as GetParametersByPathCommand).input.NextToken).toBe("p2");
  });

  it("should stop reading pages once the count reaches stopAt", async () => {
    const send = vi.fn().mockResolvedValue(pageOf(10, "more"));
    expect(await countTenantTeamParameters(deps(send), "t1", "/x", 20)).toBe(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("should count only parameters whose name ends with the suffix", async () => {
    const send = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/dev/tenants/t1/teams/a/sakura-api-key" },
        { Name: "/dev/tenants/t1/teams/a/azure-credential" },
        { Name: "/dev/tenants/t1/teams/b/sakura-api-key" },
        {},
      ],
    });
    expect(await countTenantTeamParameters(deps(send), "t1", "/sakura-api-key", 99)).toBe(2);
  });

  it("should count an empty page as zero", async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await countTenantTeamParameters(deps(send), "t1", "/x", 99)).toBe(0);
  });

  it("should scope the IAM pattern to the teams path of any tenant", () => {
    expect(buildTenantTeamsPathArnPattern("ap-northeast-1", "123456789012", "dev")).toBe(
      "arn:aws:ssm:ap-northeast-1:123456789012:parameter/dev/tenants/*/teams",
    );
  });
});
