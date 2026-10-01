import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationExternalIdStore } from "../../lib/problem-deploy/handlers/shared/external-id-store.js";

const ARN =
  "arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/cloud/test-installation/external-id";
const SECRET = "SYNTHETIC-EXTERNAL-ID-ONLY";
const clients: SSMClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
const error = (name: string) => Object.assign(new Error("Synthetic SDK failure"), { name });
function fixture() {
  const client = new SSMClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  const send = vi
    .spyOn(SSMClient.prototype, "send")
    .mockRejectedValue(new Error("Unexpected SSM access"));
  const reserveInitialization = vi.fn(async () => true);
  const recordUse = vi.fn(async () => undefined);
  const saved = { Parameter: { ARN, Type: "SecureString", Version: 1, Value: SECRET } };
  return {
    send,
    saved,
    reserveInitialization,
    recordUse,
    store: createInstallationExternalIdStore({
      ssm: client,
      parameterArn: ARN,
      generate: () => "GENERATED-SYNTHETIC-ONLY",
      reserveInitialization,
      recordUse,
    }),
    client,
  };
}
describe("installation ExternalId SDK contract, synthetic values only", () => {
  it("never regenerates missing key material for a non-empty or uncertain registry", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(error("ParameterNotFound"));
    f.reserveInitialization.mockResolvedValue(false);
    await expect(f.store.ensure()).rejects.toThrow(
      "restore it instead of generating a replacement",
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.recordUse).not.toHaveBeenCalled();
  });
  it("does not reveal an existing key until its durable use marker is confirmed", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve(f.saved));
    f.recordUse.mockRejectedValue(new Error("Synthetic marker write failure"));
    await expect(f.store.ensure()).rejects.toThrow("marker write failure");
    expect(f.reserveInitialization).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("recovers a confirmed SSM value after a marker-write interruption without generating another value", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(error("ParameterNotFound"))
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => Promise.resolve(f.saved))
      .mockImplementationOnce(() => Promise.resolve(f.saved));
    f.recordUse.mockRejectedValueOnce(new Error("Synthetic lost marker response"));
    await expect(f.store.ensure()).rejects.toThrow("marker response");
    expect(await f.store.ensure()).toBe(SECRET);
    expect(f.reserveInitialization).toHaveBeenCalledTimes(1);
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof PutParameterCommand),
    ).toHaveLength(1);
  });
  it("reads only the exact current SecureString and never rotates an existing value", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve(f.saved));
    expect(await f.store.ensure()).toBe(SECRET);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(f.send.mock.calls[0]?.[0].input).toEqual({ Name: ARN, WithDecryption: true });
  });
  it("creates a missing value without overwrite and confirms what was durably stored", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(error("ParameterNotFound"))
      .mockImplementationOnce(() => Promise.resolve({ Version: 1 }))
      .mockImplementationOnce(() => Promise.resolve(f.saved));
    expect(await f.store.ensure()).toBe(SECRET);
    expect(f.send.mock.calls[1]?.[0]).toBeInstanceOf(PutParameterCommand);
    expect(f.send.mock.calls[1]?.[0].input).toEqual({
      Name: "/tenkacloud/cloud/test-installation/external-id",
      Value: "GENERATED-SYNTHETIC-ONLY",
      Type: "SecureString",
      Overwrite: false,
    });
  });
  it("converges concurrent first registrations only after ParameterAlreadyExists and a fresh read", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(error("ParameterNotFound"))
      .mockRejectedValueOnce(error("ParameterAlreadyExists"))
      .mockImplementationOnce(() => Promise.resolve(f.saved));
    expect(await f.store.ensure()).toBe(SECRET);
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  it.each(["AccessDeniedException", "ParameterVersionNotFound", "ThrottlingException"])(
    "propagates %s without creating a replacement or trying an old version",
    async (name) => {
      const f = fixture();
      f.send.mockRejectedValueOnce(error(name));
      await expect(f.store.ensure()).rejects.toMatchObject({ name });
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );
  it("propagates uncertain puts and does not return an unconfirmed generated value", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(error("ParameterNotFound"))
      .mockRejectedValueOnce(error("TimeoutError"));
    await expect(f.store.ensure()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("rejects a missing post-write value rather than fabricating success", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(error("ParameterNotFound"))
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockRejectedValueOnce(error("ParameterNotFound"));
    await expect(f.store.ensure()).rejects.toThrow("not persisted");
  });
  it.each([
    { ARN: `${ARN}:1` },
    { Type: "String" },
    { Version: 0 },
    { Version: undefined },
    { Value: "short" },
    { Value: undefined },
  ])("rejects malformed or wrong parameter responses: %j", async (change) => {
    const f = fixture();
    f.send.mockImplementationOnce(() =>
      Promise.resolve({ Parameter: { ...f.saved.Parameter, ...change } }),
    );
    await expect(f.store.ensure()).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    ARN.replace("/cloud/", "/unrelated/"),
    ARN.replace("us-east-1", "cn-north-1"),
    `${ARN}:1`,
    ARN.replace("test-installation", "../other"),
    "parameter/name",
  ])("rejects non-installation identity %s before any SDK access", (parameterArn) => {
    const f = fixture();
    expect(() =>
      createInstallationExternalIdStore({
        ssm: f.client,
        parameterArn,
        reserveInitialization: f.reserveInitialization,
        recordUse: f.recordUse,
      }),
    ).toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});
