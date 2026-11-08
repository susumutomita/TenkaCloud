/* eslint-disable sonarjs/no-clear-text-protocols -- Loopback HTTP is the explicit simulator contract; remote HTTP examples must be rejected. */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../options";
import {
  assertSimulatorProxyDisabled,
  connectSimulatorHosting,
  readSimulatorToken,
  simulatorSettings,
} from "../simulator-hosting";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "tc-simulator-settings-"));
  directories.push(path);
  return path;
}
const valid = {
  "simulator-endpoint": "http://127.0.0.1:4566",
  "simulator-token-file": join(tmpdir(), "local-token"),
  "simulator-region": "ap-northeast-1",
};

test("simulator mode is explicit, all-or-nothing and does not revive legacy AWS flags", () => {
  expect(simulatorSettings({})).toBeUndefined();
  expect(() => simulatorSettings({ "simulator-bootstrap": true })).toThrow("together");
  expect(() => parseOptions(["--simulator-bootstrap"], "/tmp", {})).toThrow(
    "--simulator-region together",
  );
  expect(
    parseOptions(
      [
        ...Object.entries(valid).flatMap(([key, value]) => [`--${key}`, value]),
        "--simulator-bootstrap",
      ],
      "/tmp",
      {},
    ).simulator?.bootstrap,
  ).toBe(true);
  expect(
    parseOptions([], "/tmp", {
      AWS_ENDPOINT_URL: valid["simulator-endpoint"],
      AWS_REGION: valid["simulator-region"],
    }),
  ).not.toHaveProperty("simulator");
  expect(
    parseOptions(
      Object.entries(valid).flatMap(([key, value]) => [`--${key}`, value]),
      "/tmp",
      {},
    ).simulator,
  ).toEqual({
    endpoint: valid["simulator-endpoint"],
    tokenFile: valid["simulator-token-file"],
    region: valid["simulator-region"],
  });
  for (const key of Object.keys(valid)) {
    const partial = Object.fromEntries(
      Object.entries(valid).filter(([candidate]) => candidate !== key),
    );
    expect(() => simulatorSettings(partial)).toThrow("together");
  }
  expect(() =>
    parseOptions(
      [
        "--aws-region",
        "ap-northeast-1",
        ...Object.entries(valid).flatMap(([key, value]) => [`--${key}`, value]),
      ],
      "/tmp",
      {},
    ),
  ).toThrow("AWS problems require cloud hosting");
});

test("only literal loopback HTTP targets are accepted, never DNS or URL normalization tricks", () => {
  for (const endpoint of [
    "https://127.0.0.1:4566",
    "http://localhost:4566",
    "http://169.254.169.254:80",
    "http://example.com:4566",
    "http://127.1:4566",
    "http://2130706433:4566",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://user:secret@127.0.0.1:4566",
    "http://127.0.0.1:4566/path",
    "http://127.0.0.1:4566/?query=1",
    "http://127.0.0.1:4566/#x",
  ])
    expect(() => simulatorSettings({ ...valid, "simulator-endpoint": endpoint })).toThrow(
      "numeric loopback",
    );
  expect(
    simulatorSettings({ ...valid, "simulator-endpoint": "http://[::1]:4566/" })?.endpoint,
  ).toBe("http://[::1]:4566");
  expect(() => simulatorSettings({ ...valid, "simulator-region": "invalid" })).toThrow("region");
});

test("operator token files must be private regular owned files with bounded valid content", () => {
  const root = directory();
  const path = join(root, "token");
  const token = "x".repeat(64);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  expect(readSimulatorToken(path)).toBe(token);
  linkSync(path, join(root, "hardlink"));
  expect(() => readSimulatorToken(path)).toThrow("owner-only");
  unlinkSync(join(root, "hardlink"));
  chmodSync(path, 0o644);
  expect(() => readSimulatorToken(path)).toThrow("owner-only");
  chmodSync(path, 0o600);
  symlinkSync(path, join(root, "link"));
  expect(() => readSimulatorToken(join(root, "link"))).toThrow("symlinks");
  mkdirSync(join(root, "dir"));
  expect(() => readSimulatorToken(join(root, "dir"))).toThrow("regular file");
  expect(() => readSimulatorToken(join(root, "missing"))).toThrow("not found");
  for (const value of ["short", "!".repeat(64), "x".repeat(258), `${token}\nextra`]) {
    writeFileSync(path, value);
    expect(() => readSimulatorToken(path)).toThrow("valid local operator token");
  }
});

test("simulator mode rejects remotely exposed participant hosting", () => {
  const flags = Object.entries(valid).flatMap(([key, value]) => [`--${key}`, value]);
  for (const exposure of [
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Rejected fixture address; this test never opens a listener.
    ["--lan", "192.168.1.2", "--unsafe-lan"],
    [
      "--public-admin-origin",
      "https://admin.example.test",
      "--public-participant-origin",
      "https://play.example.test",
    ],
    [
      "--console-origin",
      "https://play.example.test",
      "--web-origin-template",
      "https://{target}.labs.example.test",
      "--competition-network",
      "--docker-network-pool",
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Parsed fixture pool only; simulator exposure is rejected before networking.
      "10.200.0.0/24",
    ],
  ])
    expect(() => parseOptions([...flags, ...exposure], "/tmp", {})).toThrow(
      "same-machine loopback",
    );
});

test("simulator host rejects every ambient proxy spelling, even with local exclusions", () => {
  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "Http_Proxy",
  ]) {
    expect(() =>
      assertSimulatorProxyDisabled({
        [key]: "http://127.0.0.1:1234",
        NO_PROXY: "*",
        no_proxy: "127.0.0.1",
      }),
    ).toThrow("No request was sent");
  }
  expect(() =>
    assertSimulatorProxyDisabled({ HTTP_PROXY: "", NO_PROXY: "example.test" }),
  ).not.toThrow();
});

test("simulator SDK rechecks proxy configuration after startup before signing any request", async () => {
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(http|https|all)_proxy$/iu.test(key)),
  );
  for (const key of Object.keys(saved)) Reflect.deleteProperty(process.env, key);
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return new Response(
        "<GetCallerIdentityResponse><GetCallerIdentityResult><Account>999999999999</Account><Arn>arn:aws:iam::999999999999:root</Arn><UserId>synthetic</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>",
        { headers: { "Content-Type": "text/xml" } },
      );
    },
  });
  const data = directory();
  const tokenFile = join(data, "token");
  writeFileSync(tokenFile, "x".repeat(64), { mode: 0o600 });
  try {
    const connection = await connectSimulatorHosting(process.cwd(), join(data, "host"), {
      endpoint: `http://127.0.0.1:${server.port}`,
      region: "ap-northeast-1",
      tokenFile,
    });
    if (!connection) throw new Error("Simulator connection missing");
    expect(requests).toBe(1);
    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      process.env[key] = `http://127.0.0.1:${server.port}`;
      await expect(connection.verify("000000000000", "SyntheticRole")).rejects.toThrow(
        "No request was sent",
      );
      expect(requests).toBe(1);
      Reflect.deleteProperty(process.env, key);
    }
  } finally {
    for (const key of Object.keys(process.env).filter((key) =>
      /^(http|https|all)_proxy$/iu.test(key),
    ))
      Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, saved);
    server.stop(true);
  }
});
