import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../cli/process";
import { runTursoLiveCommand, type TursoLiveCommandDeps } from "../cli/turso-live-command";
import { loadTursoLiveEnvironment } from "../cli/turso-live-environment";
import { runTursoLiveSetup } from "../cli/turso-live-setup";
import { runEnvInit } from "./env-init";
import { runCloudFormationVerification } from "./turso-live-guide";
import {
  describeTursoTokenExpiry,
  parseTursoDatabaseList,
  runTursoTokenRotate,
  type TursoTokenRotateDeps,
} from "./turso-token-rotate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const token = `header.${Buffer.from(JSON.stringify({ id: "fixture", a: "rw" })).toString("base64url")}.signature`;
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const baseEnv = {
  ENV: "staging",
  ACCOUNT_ID: "123456789012",
  AWS_REGION: "ap-northeast-1",
  AWS_PROFILE: "fixture-profile",
  TENKACLOUD_ADMIN_EMAIL: "organizer@example.test",
  CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
  CDK_PARAM_TURSO_DATABASE_URL: "https://fixture.turso.io",
  CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/staging/turso/auth-token",
  TENKACLOUD_STACK_LAYOUT: "cloud",
};
function rootWithEnv(env: NodeJS.ProcessEnv = baseEnv): string {
  const root = mkdtempSync(join(tmpdir(), "turso-workflow-"));
  roots.push(root);
  const directory = join(root, "infrastructure/environments/staging");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, ".env"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  return root;
}
interface Call {
  command: string;
  args: readonly string[];
  options: Parameters<ProcessRunner["run"]>[2];
}
function fixture(root = rootWithEnv()) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const prompts: string[] = [];
  const posted: unknown[][] = [];
  const runner: ProcessRunner = {
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return fixtureCommand(command, args);
    },
  };
  const deps: TursoLiveCommandDeps = {
    repoRoot: root,
    processRunner: runner,
    interactive: true,
    platform: "linux",
    architecture: "x64",
    homeDirectory: root,
    installTursoCli: () => {
      throw new Error("No install expected");
    },
    confirm: async (question) => {
      prompts.push(question);
      return true;
    },
    prompt: async (question) => (question.includes("deploy と") ? "deploy" : "fixture"),
    log: (line) => logs.push(line),
    httpPost: async (...args) => {
      posted.push(args);
      return { results: [{ type: "ok", response: { type: "execute" } }, { type: "ok" }] };
    },
    probeTurso: async (url, saved) => {
      expect(url).toBe(baseEnv.CDK_PARAM_TURSO_DATABASE_URL);
      expect(saved).toBe(token);
    },
  };
  return { root, calls, logs, prompts, posted, runner, deps };
}

test("first-run env-init writes current deployment keys, mode 0600, and preserves an existing file", async () => {
  const root = rootWithEnv();
  rmSync(join(root, "infrastructure/environments/staging/.env"));
  writeFileSync(
    join(root, "infrastructure/environments/staging/.env.example"),
    "ENV=staging\nTENKACLOUD_ADMIN_EMAIL=\nACCOUNT_ID=\nAWS_REGION=\nCDK_PARAM_CONTROL_DATA_BACKEND=dynamodb\n",
  );
  const options = {
    env: "staging",
    repoRoot: root,
    ask: async () => "",
    print: () => undefined,
    nonInteractive: true,
    values: baseEnv,
  };
  const first = await runEnvInit(options);
  expect(first.status).toBe("created");
  expect(statSync(first.path).mode & 0o777).toBe(0o600);
  expect(loadTursoLiveEnvironment(root, "staging", {}).env).toMatchObject({
    ACCOUNT_ID: baseEnv.ACCOUNT_ID,
    TENKACLOUD_ADMIN_EMAIL: baseEnv.TENKACLOUD_ADMIN_EMAIL,
  });
  const original = readFileSync(first.path, "utf8");
  expect((await runEnvInit({ ...options, values: { ACCOUNT_ID: "999999999999" } })).status).toBe(
    "exists",
  );
  expect(readFileSync(first.path, "utf8")).toBe(original);
});

test("env-init rejects missing unattended input and traversal without creating config", async () => {
  const root = rootWithEnv();
  rmSync(join(root, "infrastructure/environments/staging/.env"));
  writeFileSync(join(root, "infrastructure/environments/staging/.env.example"), "ENV=staging\n");
  const options = {
    env: "staging",
    repoRoot: root,
    ask: async () => "",
    print: () => undefined,
    nonInteractive: true,
  };
  await expect(runEnvInit(options)).rejects.toThrow("TENKACLOUD_ADMIN_EMAIL");
  await expect(runEnvInit({ ...options, env: "../escape" })).rejects.toThrow();
});

test("wizard wires selected file/profile, token stdin, refreshed settings, current deploy and verification", async () => {
  const f = fixture();
  expect(await runTursoLiveCommand([], { ENV: "staging" }, f.deps)).toBe(0);
  const stored = f.calls.find((call) => call.args[1] === "put-parameter");
  expect(stored?.options?.input).toBe(token);
  expect(stored?.args).toContain("file:///dev/stdin");
  expect(stored?.args).not.toContain("--overwrite");
  const deploy = f.calls.find((call) => call.command === "make");
  expect(deploy?.args).toEqual(["deploy", "ENV=staging"]);
  expect(deploy?.options?.env).toMatchObject(baseEnv);
  expect(f.calls.every((call) => call.options?.env?.AWS_PROFILE === "fixture-profile")).toBe(true);
  expect(
    f.calls
      .filter((call) => call.args[1] === "list-stack-resources")
      .map((call) => call.args.join(" "))
      .join("\n"),
  ).toContain("tenkacloud-cloud");
  expect(
    readFileSync(join(f.root, "infrastructure/environments/staging/.env"), "utf8"),
  ).not.toContain(token);
  expect(f.logs.join("\n")).not.toContain(token);
  expect(JSON.stringify(f.calls.map((call) => call.args))).not.toContain(token);
});

test("rotation forwards real CLI flags and selected region/profile; token never enters argv or logs", async () => {
  const f = fixture();
  expect(
    await runTursoLiveCommand(
      ["rotate-token", "--database", "fixture", "--expiration", "30d", "--invalidate", "--yes"],
      { ENV: "staging", AWS_REGION: "us-west-2" },
      f.deps,
    ),
  ).toBe(0);
  expect(f.calls.find((call) => call.args[2] === "create")?.args).toEqual([
    "db",
    "tokens",
    "create",
    "fixture",
    "--expiration",
    "30d",
  ]);
  expect(f.calls.find((call) => call.args[2] === "invalidate")?.args).toEqual([
    "db",
    "tokens",
    "invalidate",
    "fixture",
    "--yes",
  ]);
  const put = f.calls.find((call) => call.args[1] === "put-parameter");
  expect(put?.args).toContain("--overwrite");
  expect(put?.args).toContain("us-west-2");
  expect(put?.options?.input).toBe(token);
  expect(f.calls.every((call) => call.options?.env?.AWS_PROFILE === "fixture-profile")).toBe(true);
  expect(f.posted[0]?.[1]).toBe(token);
  expect(f.logs.join("\n")).not.toContain(token);
  expect(JSON.stringify(f.calls.map((call) => call.args))).not.toContain(token);
});

for (const args of [["--database"], ["--expiration", "--yes"], ["--unknown"], ["--yes", "--yes"]]) {
  test(`malformed rotation arguments stop before subprocesses: ${args.join(" ")}`, async () => {
    const f = fixture();
    await expect(
      runTursoLiveCommand(["rotate-token", ...args], { ENV: "staging" }, f.deps),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
}

test("unattended rotation without --yes does not mint or store a token", async () => {
  const f = fixture();
  expect(
    await runTursoLiveCommand(
      ["rotate-token"],
      { ENV: "staging" },
      { ...f.deps, interactive: false },
    ),
  ).toBe(1);
  expect(
    f.calls.some((call) => call.args[2] === "create" || call.args[1] === "put-parameter"),
  ).toBe(false);
});

test("wrong AWS account stops rotation before Turso or SSM", async () => {
  const f = fixture();
  await expect(
    runTursoLiveCommand(
      ["rotate-token", "--yes"],
      { ENV: "staging", ACCOUNT_ID: "999999999999" },
      f.deps,
    ),
  ).rejects.toThrow("credentials");
  expect(f.calls.map((call) => call.command)).toEqual(["aws"]);
});

test("wrong database name fails before invalidation and issuance", async () => {
  const f = fixture();
  const deps = {
    ...f.deps,
    processRunner: {
      run: (command: string, args: readonly string[], options: Call["options"]) =>
        args[1] === "show" ? ok("https://other.turso.io") : f.runner.run(command, args, options),
    },
  };
  await expect(
    runTursoLiveCommand(
      ["rotate-token", "--database", "other", "--invalidate", "--yes"],
      { ENV: "staging" },
      deps,
    ),
  ).rejects.toThrow("does not match");
  expect(f.calls.some((call) => call.args[1] === "tokens")).toBe(false);
});

test("help and guide do no I/O even without setup; noninteractive wizard does not mutate", async () => {
  const f = fixture();
  expect(await runTursoLiveCommand(["guide"], { ENV: "staging" }, f.deps)).toBe(0);
  expect(f.calls).toHaveLength(0);
  expect(await runTursoLiveCommand([], { ENV: "staging" }, { ...f.deps, interactive: false })).toBe(
    1,
  );
  expect(f.calls).toHaveLength(0);
});

test("preflight uses authenticated SELECT 1; provider and malformed SSM failures cannot pass", async () => {
  const f = fixture();
  expect(await runTursoLiveCommand(["preflight"], { ENV: "staging" }, f.deps)).toBe(0);
  expect(
    await runTursoLiveCommand(
      ["preflight"],
      { ENV: "staging", CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb" },
      f.deps,
    ),
  ).toBe(1);
  const failure = {
    ...f.deps,
    processRunner: {
      run: (command: string, args: readonly string[], options: Call["options"]) =>
        args[1] === "get-parameter" ? ok("{}") : f.runner.run(command, args, options),
    },
  };
  expect(await runTursoLiveCommand(["preflight"], { ENV: "staging" }, failure)).toBe(1);
});

test("verification follows explicit legacy layout and fails on unreadable table counts", async () => {
  const f = fixture();
  const env = { ...baseEnv, TENKACLOUD_STACK_LAYOUT: "lite" };
  expect((await runCloudFormationVerification("staging", env, f.runner.run)).ok).toBe(true);
  expect(f.calls.some((call) => call.args.includes("tenkacloud-lite-staging"))).toBe(true);
  const result = await runCloudFormationVerification("staging", env, (command, args) =>
    args[1] === "list-stack-resources" ? ok("unknown") : f.runner.run(command, args),
  );
  expect(result.ok).toBe(false);
});

test("setup cancels before secret creation and rejects changing an existing database", async () => {
  const f = fixture();
  const deps = { ...f.deps, tursoExecutable: "turso", confirm: async () => false };
  expect((await runTursoLiveSetup("staging", baseEnv, deps)).ok).toBe(false);
  expect(f.calls.some((call) => call.args[1] === "tokens")).toBe(false);
  const other = {
    ...f.deps,
    tursoExecutable: "turso",
    processRunner: {
      run: (command: string, args: readonly string[], options: Call["options"]) =>
        args[1] === "show" ? ok("https://other.turso.io") : f.runner.run(command, args, options),
    },
  };
  await expect(runTursoLiveSetup("staging", baseEnv, other)).rejects.toThrow("differs");
});

test("rotation rejects malformed verification responses and redacts server echoes", async () => {
  const f = fixture();
  const options: TursoTokenRotateDeps = {
    env: baseEnv,
    environment: "staging",
    processRunner: f.runner,
    tursoExecutable: "turso",
    invalidate: false,
    expiration: "never",
    interactive: false,
    assumeYes: true,
    confirm: f.deps.confirm,
    log: f.deps.log,
    httpPost: async () => ({}),
  };
  expect(await runTursoTokenRotate(options)).toBe(1);
  expect(
    await runTursoTokenRotate({
      ...options,
      httpPost: async () => {
        throw new Error(`rejected ${token}`);
      },
    }),
  ).toBe(1);
  expect(f.logs.join("\n")).not.toContain(token);
});

test("existing token helpers keep JWT expiry and database-list parsing", () => {
  expect(describeTursoTokenExpiry(token)).toEqual({ kind: "never" });
  expect(describeTursoTokenExpiry("bad")).toEqual({ kind: "unknown" });
  expect(
    parseTursoDatabaseList("NAME GROUP URL\nfixture default libsql://fixture.turso.io"),
  ).toEqual([{ name: "fixture", url: "libsql://fixture.turso.io" }]);
});

function fixtureCommand(command: string, args: readonly string[]) {
  if (args[0] === "--version" || args[0] === "auth") return ok("fixture");
  if (command === "make") return ok();
  if (command === "turso") {
    if (args[1] === "list") return ok("NAME GROUP URL\nfixture default libsql://fixture.turso.io");
    if (args[1] === "show") return ok(baseEnv.CDK_PARAM_TURSO_DATABASE_URL);
    if (args[2] === "create") return ok(`CLI update notice\n${token}\n`);
    if (args[2] === "invalidate") return ok();
  }
  return fixtureAws(args);
}
function fixtureAws(args: readonly string[]) {
  if (args[0] === "sts") return ok(baseEnv.ACCOUNT_ID);
  switch (args[1]) {
    case "describe-parameters":
      return ok("None");
    case "put-parameter":
      return ok('{"Version":2}');
    case "get-parameter":
      return ok(JSON.stringify({ Type: "SecureString", Value: token }));
    case "describe-stacks":
      return ok("UPDATE_COMPLETE");
    case "list-stack-resources":
      return ok("0");
    default:
      throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
  }
}

test("source CLI executes actual fake aws/turso processes with flags, selected env and secret stdin", () => {
  const root = rootWithEnv();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const receipt = join(root, "calls.jsonl");
  const program = `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]); const args = process.argv.slice(2);
const input = args.includes("put-parameter") ? readFileSync(0, "utf8") : "";
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ name, args, input, profile: process.env.AWS_PROFILE, region: process.env.AWS_REGION }) + String.fromCharCode(10));
if (name === "aws" && args[0] === "sts") console.log("123456789012");
else if (name === "aws" && args[1] === "put-parameter") console.log('{"Version":3}');
else if (name === "turso" && args[1] === "show") console.log("https://fixture.turso.io");
else if (name === "turso" && args[2] === "create") console.log(${JSON.stringify(token)});
else if (args[0] === "--version" || args[0] === "auth") console.log("fixture");
else process.exit(19);
`;
  for (const name of ["aws", "turso"]) writeFileSync(join(bin, name), program, { mode: 0o700 });
  const preload = join(root, "fetch-fixture.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url, options) => {
    if (url !== "https://fixture.turso.io/v2/pipeline" || options?.headers?.Authorization !== ${JSON.stringify(`Bearer ${token}`)}) throw new Error("Unexpected fixture request");
    return Response.json({ results: [{ type: "ok", response: { type: "execute" } }, { type: "ok" }] });
  };`,
  );
  const fakeIdentity = spawnSync(join(bin, "aws"), ["sts", "get-caller-identity"], {
    encoding: "utf8",
    env: { ...baseEnv, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect({
    code: fakeIdentity.status,
    stdout: fakeIdentity.stdout,
    stderr: fakeIdentity.stderr,
  }).toMatchObject({ code: 0, stdout: "123456789012\n" });
  const cli = join(import.meta.dirname, "../tenkacloud.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "--preload",
      preload,
      cli,
      "turso-live",
      "rotate-token",
      "--database",
      "fixture",
      "--expiration",
      "30d",
      "--yes",
    ],
    { cwd: root, encoding: "utf8", env: { ...baseEnv, PATH: `${bin}:/usr/bin:/bin` } },
  );
  expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toMatchObject({
    status: 0,
  });
  expect(result.stdout + result.stderr).not.toContain(token);
  const calls = readFileSync(receipt, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          name: string;
          args: string[];
          input: string;
          profile: string;
          region: string;
        },
    );
  expect(
    calls.every((call) => call.profile === "fixture-profile" && call.region === "ap-northeast-1"),
  ).toBe(true);
  expect(calls.find((call) => call.args[2] === "create")?.args).toEqual([
    "db",
    "tokens",
    "create",
    "fixture",
    "--expiration",
    "30d",
  ]);
  expect(calls.find((call) => call.args[1] === "put-parameter")?.input).toBe(token);
  expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(token);
});

test("missing .env setup invokes the original wizard entry and reloads its settings", async () => {
  const f = fixture();
  const path = join(f.root, "infrastructure/environments/staging/.env");
  rmSync(path);
  const runner: ProcessRunner = {
    run: (command, args, options) => {
      if (command === process.execPath) {
        expect(args).toEqual(["run", "--no-env-file", join(f.root, "scripts/ops/env-init.ts")]);
        expect(options?.env?.ENV).toBe("staging");
        writeFileSync(
          path,
          Object.entries(baseEnv)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        );
        return ok();
      }
      return f.runner.run(command, args, options);
    },
  };
  const result = await runTursoLiveSetup(
    "staging",
    { ENV: "staging" },
    { ...f.deps, processRunner: runner, tursoExecutable: "turso" },
  );
  expect(result.ok).toBe(true);
  expect(result.env).toMatchObject(baseEnv);
  expect(f.calls.every((call) => call.options?.env?.AWS_PROFILE === "fixture-profile")).toBe(true);
});

test("setup rejects expired stored tokens and points to rotation without issuing another", async () => {
  const f = fixture();
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  const runner: ProcessRunner = {
    run: (command, args, options) => {
      if (args[1] === "describe-parameters") return ok("SecureString");
      if (args[1] === "get-parameter") return ok(expired);
      return f.runner.run(command, args, options);
    },
  };
  const result = await runTursoLiveSetup("staging", baseEnv, {
    ...f.deps,
    processRunner: runner,
    tursoExecutable: "turso",
  });
  expect(result.ok).toBe(false);
  expect(f.logs.join("\n")).toContain("make turso-token-rotate ENV=staging");
  expect(f.logs.join("\n")).not.toContain(expired);
  expect(f.calls.some((call) => call.args[1] === "tokens")).toBe(false);
});
