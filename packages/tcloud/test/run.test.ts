import { describe, expect, it, vi } from "vitest";
import { explainApiError, pollUntilSettled } from "../src/api-client";
import { parseArgs, requireOption, UsageError } from "../src/args";
import { cacheKey, resolveAccessToken, TokenRequestError } from "../src/auth";
import { assertNoSecrets, ConfigError, configFromEnv, parseConfig } from "../src/config";
import {
  EXIT_API,
  EXIT_DEPLOY_FAILED,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  type RunDeps,
  run,
} from "../src/run";
import {
  defaultCommandRunner,
  expiryFromExpiresIn,
  MacKeychainTokenStore,
  MemoryTokenStore,
  SecretToolTokenStore,
  selectTokenStore,
} from "../src/token-store";

/**
 * Issue #2951: `tcloud` CLI。
 *
 * 実 AWS も実ファイルも触らずに全経路を回せるよう、run() は fetch / 時計 / 設定 I/O / token
 * store を dependency で受け取る。ここで検証するのは主に次の 4 点である。
 *
 *  - token を **cache から** 返し、有効な間は token endpoint を叩かないこと (= M2M 課金の主軸)
 *  - client secret がどこにも保存されないこと
 *  - 403 forbidden_machine_route と capability 不足が人間可読になること
 *  - deploy の成否・timeout が **別々の exit code** になること (timeout を成功に丸めない)
 */

const CONFIG = {
  machineApiUrl: "https://machine.example.invalid/prod",
  tokenUrl: "https://auth.example.invalid/oauth2/token",
  clientId: "client-1",
  scopes: ["tenkacloud/ops.read", "tenkacloud/ops.deploy", "tc-tenant-tenant-1/bind"],
};

interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

function makeDeps(overrides: Partial<RunDeps> & { responses?: FakeResponse[] } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const responses = [...(overrides.responses ?? [])];
  const calls: { url: string; method: string; body?: string }[] = [];
  const written: unknown[] = [];
  let clock = 1_000_000;

  const fetchImpl = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${init.method} ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  });

  const deps: RunDeps = {
    argv: [],
    env: {},
    store: new MemoryTokenStore(),
    fetchImpl: fetchImpl as unknown as RunDeps["fetchImpl"],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    readConfig: () => CONFIG,
    writeConfig: (config) => written.push(config),
    ...overrides,
  };
  return { deps, stdout, stderr, calls, written, fetchImpl };
}

const TOKEN_RESPONSE: FakeResponse = {
  status: 200,
  body: { access_token: "token-abc", expires_in: 900, token_type: "Bearer" },
};

describe("tcloud auth", () => {
  it("should cache the token and not call the token endpoint again while it is valid", async () => {
    const store = new MemoryTokenStore();
    const first = makeDeps({
      store,
      argv: ["deployments", "list"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE, { status: 200, body: { items: [] } }],
    });
    expect(await run(first.deps)).toBe(EXIT_OK);
    expect(first.calls.map((call) => call.url)).toEqual([
      CONFIG.tokenUrl,
      `${CONFIG.machineApiUrl}/deployments`,
    ]);

    // 2 回目は同じ store を使う。token endpoint は呼ばれない。
    const second = makeDeps({
      store,
      argv: ["deployments", "list"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [{ status: 200, body: { items: [] } }],
    });
    expect(await run(second.deps)).toBe(EXIT_OK);
    expect(second.calls.map((call) => call.url)).toEqual([`${CONFIG.machineApiUrl}/deployments`]);
  });

  it("should never hand the client secret to the config writer", async () => {
    const { deps, written } = makeDeps({
      argv: ["auth", "login", "--client-id", "client-1", "--client-secret", "s3cret"],
      env: {
        TCLOUD_MACHINE_API_URL: CONFIG.machineApiUrl,
        TCLOUD_TOKEN_URL: CONFIG.tokenUrl,
        TCLOUD_SCOPES: CONFIG.scopes.join(" "),
      },
      responses: [TOKEN_RESPONSE],
    });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).not.toContain("s3cret");
  });

  it("should refuse to persist anything that looks like a secret", () => {
    expect(() => assertNoSecrets({ clientId: "x", clientSecret: "y" })).toThrow(ConfigError);
    expect(() => assertNoSecrets({ clientId: "x", accessToken: "y" })).toThrow(ConfigError);
    expect(() => assertNoSecrets({ clientId: "x", machineApiUrl: "y" })).not.toThrow();
  });

  it("should say what to do when there is no cached token and no secret", async () => {
    const { deps, stderr } = makeDeps({ argv: ["deployments", "list"] });
    expect(await run(deps)).toBe(EXIT_API);
    expect(stderr.join("\n")).toContain("tcloud auth login");
  });

  it("should translate invalid_scope into an actionable message", async () => {
    const { deps, stderr } = makeDeps({
      argv: ["deployments", "list"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [{ status: 400, body: { error: "invalid_scope" } }],
    });
    expect(await run(deps)).toBe(EXIT_API);
    expect(stderr.join("\n")).toContain("invalid_scope");
    expect(stderr.join("\n")).toContain("issue-machine-client.sh list");
  });

  it("should clear the cached token on logout", async () => {
    const store = new MemoryTokenStore();
    store.write(cacheKey(CONFIG.clientId, CONFIG.scopes), {
      accessToken: "token-abc",
      expiresAtMs: 2_000_000,
    });
    const { deps } = makeDeps({ store, argv: ["auth", "logout"] });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(store.read(cacheKey(CONFIG.clientId, CONFIG.scopes), 1_000_000)).toBeUndefined();
  });

  it("should report the cache backing and remaining validity in status", async () => {
    const store = new MemoryTokenStore();
    store.write(cacheKey(CONFIG.clientId, CONFIG.scopes), {
      accessToken: "token-abc",
      expiresAtMs: 1_600_000,
    });
    const { deps, stdout } = makeDeps({ store, argv: ["auth", "status"] });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(stdout.join("\n")).toContain("memory only");
    expect(stdout.join("\n")).toContain("valid for about 10 minute(s)");
  });
});

describe("tcloud deploy", () => {
  const deployArgs = [
    "deploy",
    "hello-world",
    "--account",
    "123456789012",
    "--region",
    "ap-northeast-1",
    "--team",
    "Team A",
  ];

  it("should start a deployment and poll it to completion", async () => {
    const { deps, stdout, calls } = makeDeps({
      argv: deployArgs,
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [
        TOKEN_RESPONSE,
        { status: 202, body: { jobId: "job-1" } },
        { status: 200, body: { jobId: "job-1", status: "IN_PROGRESS" } },
        { status: 200, body: { jobId: "job-1", status: "COMPLETE" } },
      ],
    });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(stdout.join("\n")).toContain("jobId: job-1");
    expect(stdout.join("\n")).toContain("status: COMPLETE");
    expect(calls[1]?.body).toContain('"awsAccountId":"123456789012"');
  });

  it("should exit 3 when the deployment finishes in a failed state", async () => {
    const { deps, stderr } = makeDeps({
      argv: deployArgs,
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [
        TOKEN_RESPONSE,
        { status: 202, body: { jobId: "job-1" } },
        { status: 200, body: { jobId: "job-1", status: "FAILED" } },
      ],
    });
    expect(await run(deps)).toBe(EXIT_DEPLOY_FAILED);
    expect(stderr.join("\n")).toContain("FAILED");
  });

  it("should exit 4 on timeout rather than reporting success", async () => {
    const { deps, stderr } = makeDeps({
      argv: [...deployArgs, "--wait-timeout", "1", "--poll-interval", "2"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [
        TOKEN_RESPONSE,
        { status: 202, body: { jobId: "job-1" } },
        { status: 200, body: { jobId: "job-1", status: "IN_PROGRESS" } },
      ],
    });
    expect(await run(deps)).toBe(EXIT_TIMEOUT);
    expect(stderr.join("\n")).toContain("timed out");
    expect(stderr.join("\n")).toContain("still running");
  });

  it("should skip polling with --no-wait", async () => {
    const { deps, calls } = makeDeps({
      argv: [...deployArgs, "--no-wait"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE, { status: 202, body: { jobId: "job-1" } }],
    });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(calls).toHaveLength(2);
  });

  it("should explain a forbidden_machine_route denial in human terms", async () => {
    const { deps, stderr } = makeDeps({
      argv: deployArgs,
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE, { status: 403, body: { error: "forbidden_machine_route" } }],
    });
    expect(await run(deps)).toBe(EXIT_API);
    const message = stderr.join("\n");
    expect(message).toContain("到達できません");
    expect(message).toContain("--preset deploy");
  });

  it("should require every deploy input", async () => {
    const { deps, stderr } = makeDeps({ argv: ["deploy", "hello-world", "--account", "1"] });
    expect(await run(deps)).toBe(EXIT_USAGE);
    expect(stderr.join("\n")).toContain("--region");
  });
});

describe("tcloud deployments", () => {
  it("should list and get", async () => {
    const list = makeDeps({
      argv: ["deployments", "list"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE, { status: 200, body: { items: [{ jobId: "job-1" }] } }],
    });
    expect(await run(list.deps)).toBe(EXIT_OK);
    expect(list.stdout.join("\n")).toContain("job-1");

    const get = makeDeps({
      argv: ["deployments", "get", "job-1"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE, { status: 200, body: { jobId: "job-1", status: "COMPLETE" } }],
    });
    expect(await run(get.deps)).toBe(EXIT_OK);
    expect(get.calls[1]?.url).toBe(`${CONFIG.machineApiUrl}/deployments/job-1`);
  });

  it("should reject an unknown subcommand", async () => {
    const { deps } = makeDeps({
      argv: ["deployments", "nuke"],
      env: { TCLOUD_CLIENT_SECRET: "s3cret" },
      responses: [TOKEN_RESPONSE],
    });
    expect(await run(deps)).toBe(EXIT_USAGE);
  });
});

describe("tcloud usage", () => {
  it("should print usage with no arguments and exit 0", async () => {
    const { deps, stdout } = makeDeps({ argv: [] });
    expect(await run(deps)).toBe(EXIT_OK);
    expect(stdout.join("\n")).toContain("tcloud auth login");
  });

  it("should reject an unknown command", async () => {
    const { deps } = makeDeps({ argv: ["destroy-everything"] });
    expect(await run(deps)).toBe(EXIT_USAGE);
  });

  it("should reject an unknown auth subcommand", async () => {
    const { deps } = makeDeps({ argv: ["auth", "sudo"] });
    expect(await run(deps)).toBe(EXIT_USAGE);
  });
});

describe("configuration", () => {
  it("should demand a tenant binding scope", () => {
    expect(() => parseConfig({ ...CONFIG, scopes: ["tenkacloud/ops.read"] })).toThrow(
      /binding scope/,
    );
  });

  it("should name the missing fields", () => {
    expect(() => parseConfig({ clientId: "c", scopes: CONFIG.scopes })).toThrow(
      /machineApiUrl, tokenUrl/,
    );
  });

  it("should build a config from the environment when it is complete", () => {
    expect(
      configFromEnv({
        TCLOUD_MACHINE_API_URL: CONFIG.machineApiUrl,
        TCLOUD_TOKEN_URL: CONFIG.tokenUrl,
        TCLOUD_CLIENT_ID: CONFIG.clientId,
        TCLOUD_SCOPES: CONFIG.scopes.join(" "),
      }),
    ).toEqual(CONFIG);
    expect(configFromEnv({ TCLOUD_CLIENT_ID: "c" })).toBeUndefined();
  });

  it("should reject a non-object config", () => {
    expect(() => parseConfig("nope")).toThrow(ConfigError);
  });
});

describe("argument parsing", () => {
  it("should accept --key value and --key=value and bare flags", () => {
    const parsed = parseArgs(["deploy", "p1", "--a", "1", "--b=2", "--flag"]);
    expect(parsed.positional).toEqual(["deploy", "p1"]);
    expect(parsed.options).toEqual({ a: "1", b: "2", flag: true });
  });

  it("should treat a bare flag as a missing value for a required option", () => {
    expect(() => requireOption(parseArgs(["--team"]), "team")).toThrow(UsageError);
  });
});

describe("token store selection", () => {
  it("should pick the macOS keychain on darwin", () => {
    const store = selectTokenStore({ platform: "darwin", hasCommand: () => true });
    expect(store).toBeInstanceOf(MacKeychainTokenStore);
    expect(store.persistent).toBe(true);
  });

  it("should pick secret-tool on linux when it exists", () => {
    const store = selectTokenStore({
      platform: "linux",
      hasCommand: (command) => command === "secret-tool",
    });
    expect(store).toBeInstanceOf(SecretToolTokenStore);
  });

  it("should fall back to memory rather than a plaintext file", () => {
    const store = selectTokenStore({ platform: "linux", hasCommand: () => false });
    expect(store).toBeInstanceOf(MemoryTokenStore);
    expect(store.persistent).toBe(false);
    expect(store.description).toContain("no OS keychain");
  });

  it("should round-trip through the macOS keychain and ignore an expired entry", () => {
    let stored = "";
    const store = new MacKeychainTokenStore((_command, args) => {
      if (args[0] === "add-generic-password") {
        stored = args[args.length - 1] as string;
        return { status: 0, stdout: "" };
      }
      if (args[0] === "find-generic-password") {
        return stored ? { status: 0, stdout: stored } : { status: 1, stdout: "" };
      }
      stored = "";
      return { status: 0, stdout: "" };
    });
    store.write("k", { accessToken: "t", expiresAtMs: 2_000 });
    expect(store.read("k", 1_000)?.accessToken).toBe("t");
    expect(store.read("k", 3_000)).toBeUndefined();
    store.clear("k");
    expect(store.read("k", 1_000)).toBeUndefined();
  });

  it("should treat a corrupted keychain entry as a cache miss", () => {
    const store = new SecretToolTokenStore(() => ({ status: 0, stdout: "not json" }));
    expect(store.read("k", 1_000)).toBeUndefined();
  });

  it.each([
    ["accessToken が string でない", JSON.stringify({ accessToken: 1, expiresAtMs: 9_000 })],
    ["expiresAtMs が number でない", JSON.stringify({ accessToken: "t", expiresAtMs: "9000" })],
    ["どちらも欠けている", JSON.stringify({ unrelated: true })],
    ["object ですらない", JSON.stringify("just-a-string")],
  ])("should treat a keychain entry whose %s as a cache miss", (_label, stdout) => {
    // JSON として読めても shape が違えば使わない。ここを通すと `accessToken` に number が
    // 入ったまま Authorization header へ渡り、原因の判りにくい 401 になる。
    const store = new SecretToolTokenStore(() => ({ status: 0, stdout }));
    expect(store.read("k", 1_000)).toBeUndefined();
  });

  it("should actually run a command through the default runner", () => {
    // 既定の runner だけが本物の process を起動する。ここを test double で置き換えたままに
    // すると、上の store の test が全部通っても実機で 1 度も動かない可能性が残る。
    expect(defaultCommandRunner("printf", ["%s", "hello"])).toEqual({
      status: 0,
      stdout: "hello",
    });
    // stdin を渡す経路 (secret-tool store が使う) も同じ関数で通す。
    expect(defaultCommandRunner("cat", [], "piped").stdout).toBe("piped");
  });

  it("should round-trip through secret-tool", () => {
    let stored = "";
    const store = new SecretToolTokenStore((_command, args, input) => {
      if (args[0] === "store") {
        stored = input ?? "";
        return { status: 0, stdout: "" };
      }
      if (args[0] === "lookup") return { status: 0, stdout: stored };
      stored = "";
      return { status: 0, stdout: "" };
    });
    store.write("k", { accessToken: "t", expiresAtMs: 5_000 });
    expect(store.read("k", 1_000)?.accessToken).toBe("t");
    store.clear("k");
    expect(store.read("k", 1_000)).toBeUndefined();
  });

  it("should subtract a safety margin from the advertised expiry", () => {
    // 往復の途中で切れて 401 になるのを避けるためのマージン。
    expect(expiryFromExpiresIn(1_000, 900)).toBe(1_000 + 900_000 - 30_000);
    expect(expiryFromExpiresIn(1_000, 1)).toBe(1_000);
  });
});

describe("api error translation", () => {
  it.each([
    ["forbidden_machine_route", 403, "到達できません"],
    ["forbidden_role", 403, "TenantMachine"],
    ["missing_tenant_claim", 401, "binding scope"],
    ["deploy_quota_exceeded", 429, "同時デプロイ"],
  ])("should explain %s", (code, status, expected) => {
    expect(explainApiError(status, code)).toContain(expected);
  });

  it("should explain a bare 401 as a scope or expiry problem", () => {
    expect(explainApiError(401, undefined)).toContain("scope");
  });

  it("should fall back to the status for an unknown code", () => {
    expect(explainApiError(500, "boom")).toContain("500");
  });
});

describe("token request failures", () => {
  it("should surface invalid_client", async () => {
    const store = new MemoryTokenStore();
    await expect(
      resolveAccessToken({
        store,
        clientId: "c",
        clientSecret: "s",
        tokenUrl: CONFIG.tokenUrl,
        scopes: CONFIG.scopes,
        nowMs: 0,
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: "invalid_client" }),
        }),
      }),
    ).rejects.toThrow(TokenRequestError);
  });

  it("should reject a response without access_token", async () => {
    await expect(
      resolveAccessToken({
        store: new MemoryTokenStore(),
        clientId: "c",
        clientSecret: "s",
        tokenUrl: CONFIG.tokenUrl,
        scopes: CONFIG.scopes,
        nowMs: 0,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      }),
    ).rejects.toThrow(/access_token/);
  });

  it("should surface a non-JSON error body by status", async () => {
    await expect(
      resolveAccessToken({
        store: new MemoryTokenStore(),
        clientId: "c",
        clientSecret: "s",
        tokenUrl: CONFIG.tokenUrl,
        scopes: CONFIG.scopes,
        nowMs: 0,
        fetchImpl: async () => ({ ok: false, status: 502, text: async () => "<html>" }),
      }),
    ).rejects.toThrow(/502/);
  });
});

describe("polling", () => {
  it("should stop at the first terminal status", async () => {
    const statuses = ["PENDING", "IN_PROGRESS", "COMPLETE"];
    let index = 0;
    const outcome = await pollUntilSettled({
      client: { getDeployment: async () => ({ jobId: "j", status: statuses[index++] as string }) },
      jobId: "j",
      intervalMs: 1,
      timeoutMs: 1000,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(outcome).toEqual({ kind: "succeeded", status: "COMPLETE" });
    expect(index).toBe(3);
  });

  it("should report a teardown status as a failure, not a success", async () => {
    const outcome = await pollUntilSettled({
      client: { getDeployment: async () => ({ jobId: "j", status: "DELETED" }) },
      jobId: "j",
      intervalMs: 1,
      timeoutMs: 1000,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(outcome.kind).toBe("failed");
  });
});
