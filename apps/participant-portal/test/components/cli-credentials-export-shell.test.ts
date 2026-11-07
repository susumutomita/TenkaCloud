import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildShellExport } from "../../src/components/cli-credentials-export";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const credentials = {
  simulator: true as const,
  endpointUrl: "http://127.0.0.1:4566",
  accessKeyId: "TCSIMASIAFIXTURE",
  secretAccessKey: "fixture-secret",
  sessionToken: "fixture-session",
  expiration: "2099-01-01T00:00:00Z",
  region: "ap-northeast-1",
  awsAccountId: "000000000000",
};
const proxyVariables = [
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** Checks shell argv/environment only; this is not an AWS or Simulator acceptance test. */
function runSetup(
  command: string,
  simulator = true,
  environment: Readonly<Record<string, string>> = {},
  endpointUrl = credentials.endpointUrl,
) {
  const directory = mkdtempSync(join(tmpdir(), "tc-cli-export-"));
  directories.push(directory);
  const argvFile = join(directory, "argv");
  const environmentFile = join(directory, "environment");
  const proxyArguments = proxyVariables.map((key) => `"\${${key}-}"`).join(" ");
  writeFileSync(
    join(directory, "aws"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$ARGV_FILE"',
      `printf '%s\\n' ${proxyArguments} > "$ENV_FILE"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const view = simulator
    ? { ...credentials, endpointUrl }
    : { ...credentials, simulator: undefined, endpointUrl: undefined };
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-c", `${buildShellExport(view)}\n${command}`],
    {
      encoding: "utf8",
      env: { ...environment, PATH: directory, ARGV_FILE: argvFile, ENV_FILE: environmentFile },
    },
  );
  return {
    result,
    argv: existsSync(argvFile) ? readFileSync(argvFile, "utf8").trimEnd().split("\n") : undefined,
    proxyEnvironment: existsSync(environmentFile)
      ? Object.fromEntries(
          readFileSync(environmentFile, "utf8")
            .split("\n")
            .slice(0, -1)
            .map((value, index) => [proxyVariables[index], value]),
        )
      : undefined,
  };
}

describe("simulator-only AWS CLI shell wrapper", () => {
  it("does not execute an AWS command while applying setup", () => {
    const { result, argv } = runSetup("");
    expect(result.status).toBe(0);
    expect(argv).toBeUndefined();
  });

  it("passes the explicit endpoint and original arguments without splitting values", () => {
    const { result, argv } = runSetup(
      "aws ssm get-parameter --name '/tc-example/hello' --query Parameter.Value --output text",
    );
    expect(result.status).toBe(0);
    expect(argv).toEqual([
      "--endpoint-url",
      credentials.endpointUrl,
      "ssm",
      "get-parameter",
      "--name",
      "/tc-example/hello",
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ]);
  });

  it("exports a loopback-only proxy bypass immediately for SDK processes", () => {
    const { result, argv } = runSetup('printf "%s\\n" "$NO_PROXY" "$no_proxy"');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("127.0.0.1\n127.0.0.1\n");
    expect(argv).toBeUndefined();
  });

  it.each([
    [{ NO_PROXY: "upper.example" }, "upper.example,127.0.0.1", "upper.example,127.0.0.1"],
    [{ no_proxy: "lower.example" }, "lower.example,127.0.0.1", "lower.example,127.0.0.1"],
    [
      { NO_PROXY: "upper.example", no_proxy: "lower.example" },
      "upper.example,127.0.0.1",
      "lower.example,127.0.0.1",
    ],
    [{ NO_PROXY: "upper.example", no_proxy: "" }, "upper.example,127.0.0.1", "127.0.0.1"],
    [{ NO_PROXY: "*" }, "*", "*"],
    [{ no_proxy: "*" }, "*", "*"],
    [{ NO_PROXY: "before,127.0.0.1,after" }, "before,127.0.0.1,after", "before,127.0.0.1,after"],
  ] as const)(
    "preserves existing proxy exclusions %j without growing on repeat setup",
    (env, upper, lower) => {
      const { result, proxyEnvironment } = runSetup(
        `${buildShellExport(credentials)}\naws sts get-caller-identity`,
        true,
        env,
      );
      expect(result.status).toBe(0);
      expect(proxyEnvironment).toMatchObject({ NO_PROXY: upper, no_proxy: lower });
    },
  );

  it.each(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])(
    "preserves the %s proxy setting for unrelated destinations",
    (variable) => {
      const { result, proxyEnvironment } = runSetup("aws sts get-caller-identity", true, {
        [variable]: "http://127.0.0.1:9876",
      });
      expect(result.status).toBe(0);
      expect(proxyEnvironment).toMatchObject({
        [variable]: "http://127.0.0.1:9876",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      });
    },
  );

  it.each([
    "unset NO_PROXY no_proxy",
    "export NO_PROXY=changed-upper.example no_proxy=changed-lower.example",
  ])("reestablishes the CLI bypass after exclusions change: %s", (change) => {
    const { result, proxyEnvironment } = runSetup(`${change}\naws sts get-caller-identity`);
    expect(result.status).toBe(0);
    expect(proxyEnvironment?.NO_PROXY.split(",")).toContain("127.0.0.1");
    expect(proxyEnvironment?.no_proxy.split(",")).toContain("127.0.0.1");
  });

  it("bypasses IPv6 loopback with both bracketed and bare host matchers", () => {
    const { result, proxyEnvironment } = runSetup(
      "aws sts get-caller-identity",
      true,
      { NO_PROXY: "unrelated.example" },
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- The Simulator accepts loopback HTTP only.
      "http://[::1]:4566",
    );
    expect(result.status).toBe(0);
    expect(proxyEnvironment).toMatchObject({
      NO_PROXY: "unrelated.example,[::1],::1",
      no_proxy: "unrelated.example,[::1],::1",
    });
  });

  it("refuses missing or changed endpoint variables before invoking the CLI", () => {
    for (const change of [
      "unset AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL='http://127.0.0.1:4567'",
      "AWS_ENDPOINT_URL=''",
      "AWS_ENDPOINT_URL='https://example.invalid'",
    ]) {
      const { result, argv } = runSetup(
        `${change}\naws ssm get-parameter --name /tc-example/hello`,
      );
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("Simulator endpoint is missing or changed");
      expect(argv).toBeUndefined();
      expect(result.stderr).not.toContain(credentials.secretAccessKey);
    }
  });

  it("rejects explicit endpoint overrides and CLI abbreviation forms", () => {
    for (const option of [
      "--endpoint-url https://example.invalid",
      "--endpoint-url=https://example.invalid",
      "--endpoint https://example.invalid",
      "--end=https://example.invalid",
      "--e https://example.invalid",
    ]) {
      const { result, argv } = runSetup(`aws ssm get-parameter --name /tc-example/hello ${option}`);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("Endpoint overrides are disabled");
      expect(argv).toBeUndefined();
    }
  });

  it("leaves ordinary AWS setup without a wrapper or injected endpoint", () => {
    const environment = {
      NO_PROXY: "upper.example",
      no_proxy: "lower.example",
      HTTP_PROXY: "http://127.0.0.1:9876",
    };
    const { result, argv, proxyEnvironment } = runSetup(
      "aws ssm get-parameter --name /tc-example/hello",
      false,
      environment,
    );
    expect(result.status).toBe(0);
    expect(argv).toEqual(["ssm", "get-parameter", "--name", "/tc-example/hello"]);
    expect(proxyEnvironment).toMatchObject(environment);
  });
});
