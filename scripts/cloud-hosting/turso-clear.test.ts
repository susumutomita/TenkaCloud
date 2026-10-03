import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Client } from "@libsql/client/http";
import { runCloudCli } from "./cli";
import type { CloudCliIo } from "./process";
import type { TursoClearTarget } from "./turso-clear";
import { withDirectTursoControlData, withTursoControlData } from "./turso-reset";

const roots: string[] = [];
const direct = {
  CDK_PARAM_TURSO_DATABASE_URL: "libsql://synthetic.turso.io",
  TURSO_AUTH_TOKEN: "synthetic-direct-token",
};
const ssm = {
  CDK_PARAM_TURSO_DATABASE_URL: direct.CDK_PARAM_TURSO_DATABASE_URL,
  CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/staging/turso/token",
  ACCOUNT_ID: "123456789012",
  AWS_REGION: "ap-northeast-1",
};
function fixture(file = "") {
  const root = mkdtempSync(join(tmpdir(), "turso-clear-command-"));
  roots.push(root);
  const directory = join(root, "infrastructure/environments/staging");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".env");
  writeFileSync(path, file);
  const output: string[] = [];
  const targets: TursoClearTarget[] = [];
  let configured = 0;
  const io: CloudCliIo = {
    run: async () => {
      throw new Error("No AWS/deployment subprocess is allowed");
    },
    configureEnvironment: () => {
      configured++;
    },
    createDestroyAssembly: () => {
      throw new Error("No deployment assembly is allowed");
    },
    clearSelectedTursoData: async (target) => {
      targets.push(target);
    },
    stdout: (value) => output.push(value),
    stderr: (value) => output.push(value),
    confirm: async () => false,
    now: Date.now,
    wait: async () => {
      throw new Error("No polling is allowed");
    },
  };
  const run = (env: NodeJS.ProcessEnv, args: string[] = []) =>
    runCloudCli(["turso-clear", ...args], io, { root, env: { ENV: "staging", ...env } });
  return { run, io, output, targets, path, configured: () => configured };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone competition-data clear credentials", () => {
  it("uses only the selected URL/process token with no AWS configuration, account or deployment backend", async () => {
    const f = fixture("TURSO_AUTH_TOKEN=synthetic-file-token\n");
    expect(
      await f.run(
        {
          ...direct,
          AWS_PROFILE: "one",
          AWS_DEFAULT_PROFILE: "two",
          AWS_ACCESS_KEY_ID: "expired",
          AWS_REGION: "invalid",
        },
        ["--plan"],
      ),
    ).toBe(0);
    expect(f.targets).toEqual([
      {
        credentials: "direct",
        databaseUrl: "https://synthetic.turso.io",
        environment: "staging",
        authToken: direct.TURSO_AUTH_TOKEN,
      },
    ]);
    expect(f.configured()).toBe(0);
    expect(readFileSync(f.path, "utf8")).toBe("TURSO_AUTH_TOKEN=synthetic-file-token\n");
    expect(f.output.join("")).not.toContain("synthetic");
  });
  it.each([undefined, "", "  "])(
    "requires a nonempty process token and never falls back to SSM: %j",
    async (token) => {
      const f = fixture("TURSO_AUTH_TOKEN=synthetic-file-secret\n");
      f.io.configureEnvironment = (env) => {
        env.TURSO_AUTH_TOKEN = "synthetic-injected-secret";
      };
      expect(await f.run({ ...ssm, TURSO_AUTH_TOKEN: token })).toBe(1);
      expect(f.targets).toEqual([]);
      expect(f.output.join("")).toContain("Tokens in .env files are ignored");
      expect(f.output.join("")).not.toContain("synthetic");
    },
  );
  it("qualifies an explicitly selected SSM path by account and region without STS", async () => {
    const f = fixture();
    expect(
      await f.run({ ...ssm, TURSO_AUTH_TOKEN: "ignored-direct-secret" }, [
        "--credentials",
        "ssm",
        "--plan",
      ]),
    ).toBe(0);
    expect(f.targets).toEqual([
      {
        credentials: "ssm",
        databaseUrl: "https://synthetic.turso.io",
        environment: "staging",
        account: "123456789012",
        region: "ap-northeast-1",
        parameterName:
          "arn:aws:ssm:ap-northeast-1:123456789012:parameter/TenkaCloud/staging/turso/token",
      },
    ]);
    expect(f.configured()).toBe(1);
    expect(f.output.join("")).not.toContain("ignored-direct-secret");
  });
  it.each([
    { ACCOUNT_ID: undefined },
    { ACCOUNT_ID: "invalid" },
    { CDK_DEFAULT_ACCOUNT: "999999999999" },
    { AWS_REGION: undefined },
    { REGION: "us-east-1" },
    { AWS_REGION: "cn-north-1" },
    { CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/turso/*" },
    {
      CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME:
        "arn:aws:ssm:us-east-1:999999999999:parameter/other",
    },
    { AWS_PROFILE: "one", AWS_DEFAULT_PROFILE: "two" },
  ])("refuses ambiguous SSM scope before connection: %j", async (override) => {
    const f = fixture();
    expect(await f.run({ ...ssm, ...override }, ["--credentials", "ssm"])).toBe(1);
    expect(f.targets).toEqual([]);
    expect(f.configured()).toBe(0);
  });
  it.each([
    undefined,
    "file:local.db",
    "https://user:synthetic-secret@synthetic.turso.io",
    "https://synthetic.turso.io/path",
    "https://synthetic.turso.io?token=synthetic-secret",
  ])("rejects an unsafe/missing direct URL without revealing it: %j", async (url) => {
    const f = fixture();
    expect(await f.run({ ...direct, CDK_PARAM_TURSO_DATABASE_URL: url })).toBe(1);
    expect(f.targets).toEqual([]);
    expect(f.output.join("")).not.toContain("synthetic-secret");
  });
  it.each(
    [
      ["--credentials"],
      ["--credentials", "bad"],
      ["--credentials", "direct", "--credentials", "ssm"],
      ["--token", "synthetic-secret"],
    ].map((args) => ({ args })),
  )("refuses unsupported arguments without echoing values: %j", async ({ args }) => {
    const f = fixture();
    expect(await f.run(direct, args)).toBe(1);
    expect(f.targets).toEqual([]);
    expect(f.output.join("")).not.toContain("synthetic-secret");
  });
});

describe("Turso connection credential confinement", () => {
  it("passes the token only to libSQL, closes the client and redacts provider failures", async () => {
    const authToken = 'synthetic+token/with"quote';
    let closed = false;
    const client = {
      close: () => {
        closed = true;
      },
    };
    let received: unknown;
    await expect(
      withDirectTursoControlData(
        { databaseUrl: "https://synthetic.turso.io", authToken },
        async () => {
          throw new Error(
            [authToken, JSON.stringify(authToken).slice(1, -1), encodeURIComponent(authToken)].join(
              " ",
            ),
          );
        },
        (config) => {
          received = config;
          return client as Client;
        },
      ),
    ).rejects.toThrow("[REDACTED] [REDACTED] [REDACTED]");
    expect(received).toEqual({ url: "https://synthetic.turso.io", authToken });
    expect(closed).toBe(true);
  });
  it("sends an exact account-qualified SSM lookup and rejects a mismatching response before SQL", async () => {
    const arn = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/TenkaCloud/staging/turso/token";
    const original = SSMClient.prototype.send;
    let request: unknown;
    SSMClient.prototype.send = (async (command: GetParameterCommand) => {
      request = command.input;
      return {
        Parameter: {
          ARN: arn.replace("123456789012", "999999999999"),
          Type: "SecureString",
          Value: "synthetic-secret",
        },
      };
    }) as typeof original;
    try {
      await expect(
        withTursoControlData(
          {
            databaseUrl: "https://synthetic.turso.io",
            region: "ap-northeast-1",
            parameterName: arn,
          },
          async () => {
            throw new Error("Must not connect");
          },
        ),
      ).rejects.toThrow("different parameter");
      expect(request).toEqual({ Name: arn, WithDecryption: true });
    } finally {
      SSMClient.prototype.send = original;
    }
  });
});
