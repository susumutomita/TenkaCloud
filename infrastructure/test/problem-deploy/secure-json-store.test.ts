import {
  type GetParameterCommand,
  ParameterNotFound,
  type PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { createSecureJsonStore } from "../../lib/problem-deploy/handlers/shared/secure-json-store.js";

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
