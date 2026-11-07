import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeContentDigest } from "../../../packages/problem-sdk/src/content-digest";
import { copyLocalCatalog } from "../../problem-pack/local-catalog";
import { sealSourcePermissions } from "../../problem-pack/source-permissions";
import { directWebTransport } from "../direct-web-transport";
import { copyFixtureRuntime, fixtureEnvironment } from "../integration/simulator-fixture";
import {
  copyFixtureSelection,
  prepareFixtureCatalog,
  readFixtureCatalogSelection,
  verifyFixtureSources,
} from "../integration/simulator-fixture-catalog";
import { verifyServedFixtureAssets } from "../integration/simulator-fixture-http";
import {
  fixtureCommandOutput,
  fixtureShellOutput,
  registerFixtureInterruptCleanup,
  spawnFixtureProcess,
  waitForFixtureReady,
  withinFixtureDeadline,
} from "../integration/simulator-fixture-process";
import { simulatorFixtureChild } from "./simulator-fixture-child";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "tenka-simulator-fixture-test-"));
  directories.push(path);
  return path;
}

function catalogFixture() {
  const base = directory();
  const source = join(base, "original");
  const repository = join(base, "repository");
  const runtime = join(base, "runtime");
  const scratch = join(base, "scratch");
  mkdirSync(join(source, "challenges/hello-world"), { recursive: true });
  mkdirSync(scratch);
  writeFileSync(join(source, "challenges/hello-world/template.yaml"), "original content\n");
  writeFileSync(join(source, ".env"), "not catalog content");
  const staging = join(base, "staging");
  copyLocalCatalog(source, staging);
  sealSourcePermissions(staging);
  const digest = computeContentDigest(staging, true);
  const snapshots = join(repository, ".tenkacloud/catalog-store/snapshots");
  mkdirSync(snapshots, { recursive: true });
  renameSync(staging, join(snapshots, digest));
  const revision = { path: source, commit: digest.slice(0, 40), digest, problemsRoot: "." };
  const identity = `${JSON.stringify({ schemaVersion: 1, sources: [revision], retained: [revision] }, null, 2)}\n`;
  const lock = join(repository, ".tenkacloud/catalog-store/selected.json");
  writeFileSync(lock, identity);
  return { base, source, repository, runtime, scratch, identity, lock, digest };
}

/** A FIFO/device regression must fail this subprocess's deadline, never block the test runner. */
async function expectBoundedCatalogRejection(
  ...args: Parameters<typeof simulatorFixtureChild>
): Promise<void> {
  const child = Bun.spawn(simulatorFixtureChild(...args), { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    expect(
      await withinFixtureDeadline(child.exited, 2000, "Catalog input refusal timed out."),
    ).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test("private catalog validation preserves exact selected source identity without reacquisition", () => {
  const fixture = catalogFixture();
  expect(copyFixtureSelection(fixture.repository, fixture.runtime)).toBe(fixture.identity);
  expect(readFixtureCatalogSelection(fixture.repository)).toBe(fixture.identity);
  verifyFixtureSources(fixture.runtime, fixture.scratch, fixture.identity);
  expect(readFileSync(fixture.lock, "utf8")).toBe(fixture.identity);
  expect(readFileSync(join(fixture.source, ".env"), "utf8")).toBe("not catalog content");
  expect(existsSync(join(fixture.scratch, "source-check-0"))).toBe(false);
  expect(existsSync(join(fixture.source, ".tenkacloud-source-modes.json"))).toBe(false);
});

test("fixture entry paths reject a symlinked selection before reading its synthetic target", async () => {
  const fixture = catalogFixture();
  const target = join(fixture.base, "synthetic-selection.json");
  renameSync(fixture.lock, target);
  symlinkSync(target, fixture.lock);
  await expectBoundedCatalogRejection("catalog-read-selection", fixture.repository);
  await expectBoundedCatalogRejection(
    "catalog-copy-selection",
    fixture.repository,
    fixture.runtime,
  );
  await expectBoundedCatalogRejection(
    "catalog-prepare",
    fixture.repository,
    fixture.runtime,
    fixture.scratch,
  );
  expect(existsSync(fixture.runtime)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(fixture.identity);
});

for (const relative of ["", ".tenkacloud", ".tenkacloud/catalog-store"]) {
  test(`fixture selection rejects a symlinked ${relative || "repository root"} directory`, async () => {
    const fixture = catalogFixture();
    const path = relative ? join(fixture.repository, relative) : fixture.repository;
    const target = join(fixture.base, "synthetic-directory-target");
    renameSync(path, target);
    symlinkSync(target, path, "dir");
    await expectBoundedCatalogRejection("catalog-read-selection", fixture.repository);
  });
}

test("FIFO, directory, oversized and device selections are promptly refused before reading", async () => {
  const fixture = catalogFixture();
  rmSync(fixture.lock);
  const mkfifo = Bun.which("mkfifo", { PATH: "/usr/bin:/bin" });
  if (!mkfifo) throw new Error("POSIX fixture tests require mkfifo.");
  expect(
    Bun.spawnSync([mkfifo, fixture.lock], { stdout: "ignore", stderr: "ignore" }).exitCode,
  ).toBe(0);
  await expectBoundedCatalogRejection("catalog-read-selection", fixture.repository);
  await expectBoundedCatalogRejection(
    "catalog-verify-sources",
    fixture.repository,
    fixture.scratch,
    fixture.identity,
  );
  rmSync(fixture.lock);
  mkdirSync(fixture.lock);
  await expectBoundedCatalogRejection("catalog-read-selection", fixture.repository);
  rmSync(fixture.lock, { recursive: true });
  writeFileSync(fixture.lock, Buffer.alloc(1024 * 1024 + 1, 120));
  await expectBoundedCatalogRejection("catalog-read-selection", fixture.repository);
  // /dev/null is a nonsensitive real device. fstat must reject it before the byte reader runs.
  await expectBoundedCatalogRejection("catalog-read-lock", "/dev/null");
}, 12_000);

for (const relative of ["snapshots", "snapshot-target"]) {
  test(`snapshot copying rejects a symlinked ${relative} before creating a private copy`, async () => {
    const fixture = catalogFixture();
    const snapshots = join(fixture.repository, ".tenkacloud/catalog-store/snapshots");
    const path = relative === "snapshots" ? snapshots : join(snapshots, fixture.digest);
    const target = join(fixture.base, "synthetic-snapshot-target");
    renameSync(path, target);
    symlinkSync(target, path, "dir");
    await expectBoundedCatalogRejection(
      "catalog-copy-selection",
      fixture.repository,
      fixture.runtime,
    );
    expect(existsSync(fixture.runtime)).toBe(false);
  });
}

test("changed original source fails before reacquisition and cleans its private verification copy", () => {
  const fixture = catalogFixture();
  copyFixtureSelection(fixture.repository, fixture.runtime);
  writeFileSync(join(fixture.source, "challenges/hello-world/template.yaml"), "changed content\n");
  expect(() => verifyFixtureSources(fixture.runtime, fixture.scratch, fixture.identity)).toThrow(
    "changed since selection",
  );
  expect(existsSync(join(fixture.scratch, "source-check-0"))).toBe(false);
  expect(readFileSync(fixture.lock, "utf8")).toBe(fixture.identity);
});

test("source links, corrupt snapshots and changed selected identities are rejected", () => {
  const fixture = catalogFixture();
  copyFixtureSelection(fixture.repository, fixture.runtime);
  symlinkSync(
    join(fixture.source, "challenges/hello-world/template.yaml"),
    join(fixture.source, "link"),
  );
  expect(() => verifyFixtureSources(fixture.runtime, fixture.scratch, fixture.identity)).toThrow(
    "symbolic link",
  );
  expect(existsSync(join(fixture.scratch, "source-check-0"))).toBe(false);
  writeFileSync(join(fixture.runtime, ".tenkacloud/catalog-store/selected.json"), "{}\n");
  expect(() => verifyFixtureSources(fixture.runtime, fixture.scratch, fixture.identity)).toThrow(
    "selected catalog identity changed",
  );
  writeFileSync(
    join(fixture.repository, ".tenkacloud/catalog-store/snapshots", fixture.digest, "extra"),
    "changed",
  );
  expect(() =>
    copyFixtureSelection(fixture.repository, join(fixture.base, "other-runtime")),
  ).toThrow("digest mismatch");
});

test("remote selections are rejected without network lookup or replacing the shared selection", () => {
  const fixture = catalogFixture();
  const identity = JSON.stringify({
    schemaVersion: 1,
    sources: [
      {
        url: "https://example.invalid/catalog.git",
        ref: "main",
        commit: "a".repeat(40),
        digest: "b".repeat(64),
        problemsRoot: ".",
      },
    ],
  });
  writeFileSync(fixture.lock, identity);
  expect(() => copyFixtureSelection(fixture.repository, fixture.runtime)).toThrow("remote sources");
  expect(readFileSync(fixture.lock, "utf8")).toBe(identity);
  expect(existsSync(fixture.runtime)).toBe(false);
});

test("a different same-name HelloWorld cannot substitute for the pinned original snapshot", () => {
  const fixture = catalogFixture();
  expect(() => prepareFixtureCatalog(fixture.repository, fixture.runtime, fixture.scratch)).toThrow(
    "pinned original Challenge snapshot",
  );
});

test("child environment excludes ambient AWS credentials, proxies and shell startup hooks", () => {
  const environment = fixtureEnvironment("/private-home", "/explicit-tool-bin");
  expect(environment.PATH).toBe("/explicit-tool-bin:/usr/bin:/bin");
  expect(environment.HOME).toBe("/private-home");
  expect(environment.AWS_CONFIG_FILE).toBe("/dev/null");
  expect(environment.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
  expect(environment.AWS_EC2_METADATA_DISABLED).toBe("true");
  for (const key of [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_ENDPOINT_URL",
    "HTTP_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "BASH_ENV",
    "NODE_OPTIONS",
  ])
    expect(environment).not.toHaveProperty(key);
});

test("runtime copying excludes nested credentials and unrelated repository state", () => {
  const root = directory();
  const repository = join(root, "repository");
  const runtime = join(root, "runtime");
  for (const name of ["scripts", "packages", "node_modules", ".aws", "unrelated"])
    mkdirSync(join(repository, name), { recursive: true });
  for (const name of ["Makefile", "package.json", "tsconfig.scripts.json", "tsconfig.host.json"])
    writeFileSync(join(repository, name), "source");
  for (const name of [
    "scripts/.env",
    "scripts/secret-key.json",
    "packages/id_rsa",
    ".aws/credentials",
    "unrelated/config",
  ])
    writeFileSync(join(repository, name), "private sentinel");
  writeFileSync(join(repository, "scripts/ordinary.ts"), "export const value = 1;");
  copyFixtureRuntime(repository, runtime, join(root, "bin"), process.execPath);
  expect(readFileSync(join(runtime, "scripts/ordinary.ts"), "utf8")).toBe(
    "export const value = 1;",
  );
  for (const name of [
    "scripts/.env",
    "scripts/secret-key.json",
    "packages/id_rsa",
    ".aws",
    "unrelated",
  ])
    expect(existsSync(join(runtime, name))).toBe(false);
  expect(readFileSync(join(repository, "scripts/.env"), "utf8")).toBe("private sentinel");
});

test("served UI checks compare body digests and reject changed assets or redirect responses", async () => {
  const root = directory();
  const path = "application-admin-console/host.html";
  mkdirSync(join(root, ".tenkacloud/host-build/application-admin-console"), { recursive: true });
  const html = "<html>original</html>";
  writeFileSync(join(root, ".tenkacloud/host-build", path), html);
  const manifest = {
    artifacts: [{ path, sha256: createHash("sha256").update(html).digest("hex") }],
  };
  let response = new Response(html);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.clone() });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  const origins = { adminOrigin: origin, participantOrigin: origin };
  try {
    await verifyServedFixtureAssets(root, manifest, origins);
    response = new Response("<html>modified</html>");
    await expect(verifyServedFixtureAssets(root, manifest, origins)).rejects.toThrow(
      "differs from its build provenance",
    );
    response = new Response(null, {
      status: 302,
      headers: { location: "https://example.invalid" },
    });
    await expect(verifyServedFixtureAssets(root, manifest, origins)).rejects.toThrow(
      "did not serve the expected",
    );
  } finally {
    await server.stop(true);
  }
});

test("readiness failure stops a real synthetic child and never returns its private output", async () => {
  const root = directory();
  const started = join(root, "started");
  const closed = join(root, "closed");
  const child = spawnFixtureProcess(simulatorFixtureChild("readiness", started, closed), {
    cwd: root,
    environment: fixtureEnvironment(root, dirname(process.execPath)),
  });
  try {
    await waitForFixtureReady(child, () => Promise.resolve(existsSync(started)), 2000, "Synthetic");
    await expect(
      waitForFixtureReady(child, () => Promise.resolve(false), 50, "Synthetic"),
    ).rejects.toThrow("readiness timed out");
  } finally {
    await child.stop();
  }
  expect(child.hasExited()).toBe(true);
  expect(child.output()).toBe("");
  expect(readFileSync(closed, "utf8")).toBe("closed");
  await child.stop();
});

for (const name of ["ordinary", "path with spaces ' \" ` ; process.exit(9)"]) {
  test(`process-group cleanup stops a real descendant after its launcher exits (${name})`, async () => {
    const root = join(directory(), name);
    mkdirSync(root);
    const started = join(root, "started");
    const closed = join(root, "closed");
    const child = spawnFixtureProcess(simulatorFixtureChild("orphan-launcher", started, closed), {
      cwd: root,
      environment: fixtureEnvironment(root, dirname(process.execPath)),
    });
    try {
      await waitForFixtureReady(
        child,
        () => Promise.resolve(existsSync(started)),
        2000,
        "Synthetic",
      );
      expect(
        await withinFixtureDeadline(child.exited, 2000, "Synthetic launcher did not exit."),
      ).toBe(0);
    } finally {
      await child.stop();
    }
    const port = readFileSync(started, "utf8");
    await expect(directWebTransport(new URL(`http://127.0.0.1:${port}/`), {})).rejects.toThrow();
    expect(child.hasExited()).toBe(true);
  });
}

test("failed version checks do not expose executable output and have finite deadlines", async () => {
  const root = directory();
  await expect(
    fixtureCommandOutput(
      [process.execPath, "-e", "console.error('synthetic-private-secret'); process.exit(4)"],
      {
        cwd: root,
        environment: fixtureEnvironment(root, dirname(process.execPath)),
      },
    ),
  ).rejects.toThrow("Tool version check failed.");
  await expect(
    withinFixtureDeadline(
      new Promise<never>(() => {
        /* Deliberately pending to exercise the deadline. */
      }),
      10,
      "Static timeout.",
    ),
  ).rejects.toThrow("Static timeout.");
});

test("normal cleanup registration is removable and does not retain process signal handlers", () => {
  const beforeInterrupt = process.listenerCount("SIGINT");
  const beforeTerminate = process.listenerCount("SIGTERM");
  const first = registerFixtureInterruptCleanup(() => Promise.resolve());
  const second = registerFixtureInterruptCleanup(() => Promise.resolve());
  expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt + 1);
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerminate + 1);
  first();
  first();
  expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt + 1);
  second();
  expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt);
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerminate);
});

test("fixture shell accepts stdin, captures only bounded stdout, and discards private stderr", async () => {
  const root = directory();
  const environment = fixtureEnvironment(root, dirname(process.execPath));
  expect(
    await fixtureShellOutput("printf 'expected value'; printf 'synthetic-private-token' >&2", {
      cwd: root,
      environment,
    }),
  ).toEqual({ exitCode: 0, stdout: "expected value" });
  await expect(
    fixtureShellOutput("printf '%70000s' x", { cwd: root, environment }),
  ).rejects.toThrow("Fixture CLI output limit exceeded.");
});

test("fixture shell timeout kills a descendant retaining stdout after its shell exits", async () => {
  const root = directory();
  const ready = join(root, "shell-descendant.json");
  const group = join(root, "shell-group");
  const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = simulatorFixtureChild("shell-descendant", ready).map(literal).join(" ");
  const script = `printf '%s' "$$" > ${literal(group)}\n${command} &\nexit 0\n`;
  try {
    await expect(
      fixtureShellOutput(script, {
        cwd: root,
        environment: fixtureEnvironment(root, dirname(process.execPath)),
        timeoutMs: 500,
      }),
    ).rejects.toThrow("Fixture CLI command timed out.");
    const details = JSON.parse(readFileSync(ready, "utf8")) as { port: number };
    await expect(
      directWebTransport(new URL(`http://127.0.0.1:${String(details.port)}/`), {}),
    ).rejects.toThrow();
  } finally {
    if (existsSync(group)) {
      try {
        process.kill(-Number(readFileSync(group, "utf8")), "SIGKILL");
      } catch (error) {
        expect(error instanceof Error && "code" in error && error.code === "ESRCH").toBe(true);
      }
    }
  }
}, 8000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`parent ${signal} waits for bounded child/descendant cleanup and deletes private state`, async () => {
    const root = directory();
    const state = join(root, "private-state");
    const ready = join(root, "ready.json");
    const parent = Bun.spawn(simulatorFixtureChild("interrupt-harness", root), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(parent.stdout).text();
    const stderr = new Response(parent.stderr).text();
    let ports: { pid: number; port: number; descendant: number } | undefined;
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(ready)).toBe(true);
      ports = JSON.parse(readFileSync(ready, "utf8")) as {
        pid: number;
        port: number;
        descendant: number;
      };
      parent.kill(signal);
      expect(
        await withinFixtureDeadline(parent.exited, 8000, "Synthetic interrupt timed out."),
      ).toBe(signal === "SIGINT" ? 130 : 143);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(root, "all-cleanups-completed"))).toBe(true);
      expect(await stdout).toBe("");
      expect(await stderr).toBe("");
      for (const port of [ports.port, ports.descendant])
        await expect(
          directWebTransport(new URL(`http://127.0.0.1:${String(port)}/`), {}),
        ).rejects.toThrow();
    } finally {
      if (parent.exitCode === null) {
        parent.kill("SIGKILL");
        await parent.exited;
      }
      if (ports) {
        try {
          process.kill(-ports.pid, "SIGKILL");
        } catch (error) {
          expect(error instanceof Error && "code" in error && error.code === "ESRCH").toBe(true);
        }
      }
    }
  }, 12_000);
}
