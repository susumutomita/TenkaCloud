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
          ...ssm,
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
    "defaults to configured SSM when the process token is absent or blank: %j",
    async (token) => {
      const file = `${Object.entries(ssm)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\nTURSO_AUTH_TOKEN=synthetic-file-secret\n`;
      const f = fixture(file);
      f.io.configureEnvironment = (env) => {
        env.TURSO_AUTH_TOKEN = "synthetic-injected-secret";
      };
      expect(await f.run({ TURSO_AUTH_TOKEN: token })).toBe(0);
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
      expect(readFileSync(f.path, "utf8")).toBe(file);
      expect(f.output.join("")).not.toContain("synthetic");
    },
  );
  it.each([undefined, "", "  "])(
    "requires a process token for explicit direct access even with SSM configured: %j",
    async (token) => {
      const f = fixture("TURSO_AUTH_TOKEN=synthetic-file-secret\n");
      expect(await f.run({ ...ssm, TURSO_AUTH_TOKEN: token }, ["--credentials", "direct"])).toBe(1);
      expect(f.targets).toEqual([]);
      expect(f.configured()).toBe(0);
      expect(f.output.join("")).toContain("Direct turso-clear requires TURSO_AUTH_TOKEN");
      expect(f.output.join("")).toContain("Tokens in .env files are ignored");
      expect(f.output.join("")).not.toContain("synthetic");
    },
  );
  it("honors explicit direct access and trims its inherited process token", async () => {
    const f = fixture("TURSO_AUTH_TOKEN=synthetic-file-secret\n");
    expect(
      await f.run({ ...ssm, ...direct, TURSO_AUTH_TOKEN: `  ${direct.TURSO_AUTH_TOKEN}  ` }, [
        "--credentials",
        "direct",
        "--plan",
      ]),
    ).toBe(0);
    expect(f.targets[0]).toMatchObject({
      credentials: "direct",
      authToken: direct.TURSO_AUTH_TOKEN,
    });
    expect(f.configured()).toBe(0);
  });
  it.each([
    {
      name: "ExpiredTokenException",
      message: "The security token included in the request is expired",
    },
    {
      name: "TokenProviderError",
      message: "The SSO session associated with this profile has expired",
    },
  ])(
    "explains AWS session renewal after an SSM credential failure: %j",
    async ({ name, message }) => {
      for (const args of [["--plan"], ["--credentials", "ssm", "--plan"]]) {
        const f = fixture();
        f.io.clearSelectedTursoData = async (target) => {
          f.targets.push(target);
          throw Object.assign(new Error(message), { name });
        };
        expect(await f.run(ssm, args)).toBe(1);
        expect(f.targets.map((target) => target.credentials)).toEqual(["ssm"]);
        expect(f.output.join("")).toContain(message);
        expect(f.output.join("")).toContain(
          "Reauthenticate the intended AWS profile using its configured AWS login or SSO method, then retry",
        );
        expect(f.output.join("")).toContain(
          "For an SSO profile, use aws sso login --profile <profile>",
        );
      }
    },
  );
  it.each([
    { name: "Error", message: "Turso token has expired", args: ["--plan"] },
    { name: "Error", message: "ExpiredToken: database token expired", args: ["--plan"] },
    { name: "ExpiredTokenException", message: "The security token has expired", args: ["--plan"] },
    {
      name: "ExpiredTokenException",
      message: "The security token has expired",
      args: ["--credentials", "direct", "--plan"],
    },
  ])(
    "does not suggest AWS login for direct Turso errors, regardless of provider name: %j",
    async ({ name, message, args }) => {
      const f = fixture();
      f.io.clearSelectedTursoData = async (target) => {
        f.targets.push(target);
        throw Object.assign(new Error(message), { name });
      };
      expect(await f.run({ ...ssm, ...direct }, [...args])).toBe(1);
      expect(f.targets.map((target) => target.credentials)).toEqual(["direct"]);
      expect(f.configured()).toBe(0);
      expect(f.output.join("")).toContain(message);
      expect(f.output.join("")).not.toContain("AWS profile");
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
  it("does not retry an explicit SSM failure with an available process token", async () => {
    const f = fixture();
    f.io.clearSelectedTursoData = async (target) => {
      f.targets.push(target);
      throw new Error("SSM retrieval failed");
    };
    expect(await f.run({ ...ssm, ...direct }, ["--credentials", "ssm", "--plan"])).toBe(1);
    expect(f.targets.map((target) => target.credentials)).toEqual(["ssm"]);
    expect(f.output.join("")).toContain("SSM retrieval failed");
  });
  it.each([
    ["CDK_PARAM_TURSO_DATABASE_URL", "CDK_PARAM_TURSO_DATABASE_URL is required"],
    ["CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME", "must name one exact rooted SSM parameter"],
    ["ACCOUNT_ID", "SSM credentials require one explicit 12-digit ACCOUNT_ID"],
    ["AWS_REGION", "SSM credentials require an explicit AWS_REGION"],
  ])("explains missing or blank default SSM configuration: %s", async (key, message) => {
    const f = fixture(
      Object.entries(ssm)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
    );
    for (const value of ["", "  "]) {
      expect(await f.run({ [key]: value }, ["--plan"])).toBe(1);
      expect(f.targets).toEqual([]);
      expect(f.configured()).toBe(0);
      expect(f.output.join("")).toContain(message);
    }
    const missing = fixture();
    expect(await missing.run({ ...ssm, [key]: undefined }, ["--plan"])).toBe(1);
    expect(missing.targets).toEqual([]);
    expect(missing.output.join("")).toContain(message);
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
    for (const args of [[], ["--credentials", "ssm"]]) {
      expect(await f.run({ ...ssm, ...override }, args)).toBe(1);
      expect(f.targets).toEqual([]);
      expect(f.configured()).toBe(0);
    }
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
