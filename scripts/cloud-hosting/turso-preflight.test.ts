import { describe, expect, it } from "bun:test";
import type { ProcessResult } from "./process";
import { verifyTursoBeforeDeployment } from "./turso-preflight";

const NOW = Date.parse("2026-10-02T00:00:00Z");
const token = "synthetic-token\nprivate-line";
function fixture(parameter: unknown = { Type: "SecureString", Value: token }) {
  const calls: string[][] = [];
  const probes: { url: string; token: string }[] = [];
  const output: string[] = [];
  const options = {
    configuration: {
      kind: "turso" as const,
      databaseUrl: "https://owned.turso.io",
      authTokenParameterName: "/TenkaCloud/staging/turso/auth-token",
    },
    region: "ap-northeast-1",
    run: async (args: readonly string[]): Promise<ProcessResult> => {
      calls.push([...args]);
      return { code: 0, stdout: JSON.stringify(parameter), stderr: "" };
    },
    probe: async (url: string, value: string) => {
      probes.push({ url, token: value });
    },
    now: NOW,
    output: (value: string) => output.push(value),
  };
  return { options, calls, probes, output };
}
function jwt(exp: number): string {
  return `synthetic.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.unsigned`;
}

describe("restored read-only Turso deploy preflight", () => {
  it("reads one exact SecureString in the selected region and probes without disclosing it", async () => {
    const f = fixture();
    await verifyTursoBeforeDeployment(f.options);
    expect(f.calls).toEqual([
      [
        "ssm",
        "get-parameter",
        "--name",
        "/TenkaCloud/staging/turso/auth-token",
        "--with-decryption",
        "--region",
        "ap-northeast-1",
        "--query",
        "Parameter",
        "--output",
        "json",
      ],
    ]);
    expect(f.probes).toEqual([{ url: "https://owned.turso.io", token }]);
    expect(f.output.join("")).toContain("read-only preflight passed");
    expect(f.output.join("")).not.toContain(token);
  });
  it.each([{}, { Type: "String", Value: token }, { Type: "SecureString", Value: " " }, null])(
    "rejects missing or non-SecureString values before a network probe: %j",
    async (value) => {
      const f = fixture(value);
      await expect(verifyTursoBeforeDeployment(f.options)).rejects.toThrow(
        "nonempty SSM SecureString",
      );
      expect(f.probes).toEqual([]);
    },
  );
  it("fails closed on unreadable or malformed SSM responses without echoing their data", async () => {
    for (const result of [
      { code: 1, stdout: token, stderr: token },
      { code: 0, stdout: token, stderr: "" },
    ]) {
      const f = fixture();
      f.options.run = async () => result;
      const error: unknown = await verifyTursoBeforeDeployment(f.options).catch((value) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(token);
      expect(f.probes).toEqual([]);
    }
  });
  it("rejects expired credentials and warns about upcoming expiry only after successful authentication", async () => {
    for (const expiry of [0, -1, NOW / 1000 - 1]) {
      const expired = fixture({ Type: "SecureString", Value: jwt(expiry) });
      await expect(verifyTursoBeforeDeployment(expired.options)).rejects.toThrow("expired");
      expect(expired.probes).toEqual([]);
    }
    const near = fixture({ Type: "SecureString", Value: jwt(NOW / 1000 + 3600) });
    await verifyTursoBeforeDeployment(near.options);
    expect(near.output.join("")).toContain("expires within seven days");
  });
  it("keeps opaque or distant-expiry credentials dependent on actual SQL authentication", async () => {
    for (const value of ["opaque", "synthetic.not-json.unsigned", jwt(NOW / 1000 + 30 * 86400)]) {
      const f = fixture({ Type: "SecureString", Value: value });
      await verifyTursoBeforeDeployment(f.options);
      expect(f.probes).toHaveLength(1);
      expect(f.output.join("")).not.toContain("expires within");
    }
  });
  it("redacts raw, escaped and encoded credential echoes from rejected queries", async () => {
    const f = fixture();
    f.options.probe = async () => {
      throw new Error(`${token}; ${JSON.stringify(token)}; ${encodeURIComponent(token)}`);
    };
    const error: unknown = await verifyTursoBeforeDeployment(f.options).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("[REDACTED]");
    for (const value of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)])
      expect(String(error)).not.toContain(value);
    expect(f.output).toEqual([]);
  });
});
