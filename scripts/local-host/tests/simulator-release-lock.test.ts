import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOfficialSimulatorBinary } from "../simulator-release-lock";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "simulator-lock-test-"));
  roots.push(root);
  return { cacheDirectory: join(root, "cache") };
}
const assets = [
  "tenkacloud-simulator_linux_amd64",
  "tenkacloud-simulator_linux_arm64",
  "tenkacloud-simulator_darwin_amd64",
  "tenkacloud-simulator_darwin_arm64",
];
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function fixture(version = "v0.1.0", protocol = 1) {
  const binary = `synthetic binary ${version}, never executed`;
  const manifest = JSON.stringify({
    version,
    host_protocol: protocol,
    source_repository: "https://github.com/susumutomita/TenkaCloudSimulator",
    source_commit: "a".repeat(40),
  });
  const sums =
    [...assets.map((name) => `${hash(binary)}  ${name}`), `${hash(manifest)}  BUILDINFO.json`].join(
      "\n",
    ) + "\n";
  return { version, binary, manifest, sums };
}
function transport(releases = [fixture()]) {
  const requests: string[] = [];
  const fetch = async (url: string, _init: RequestInit) => {
    requests.push(url);
    if (
      url === "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases?per_page=100"
    )
      return Response.json(
        releases.map((r) => ({ tag_name: r.version, draft: false, prerelease: false })),
      );
    const release = releases.find((r) => url.includes(`/${r.version}/`));
    if (!release) return new Response(null, { status: 404 });
    if (url.endsWith("/SHA256SUMS")) return new Response(release.sums);
    if (url.endsWith("/BUILDINFO.json")) return new Response(release.manifest);
    return new Response(release.binary);
  };
  return { fetch, requests, platform: "linux", arch: "x64" };
}

test("first startup resolves official release and locks verified bytes; later starts are offline", async () => {
  const options = await setup();
  const deps = transport();
  const path = await ensureOfficialSimulatorBinary(options, deps);
  expect(await readFile(path, "utf8")).toBe(fixture().binary);
  const lock = JSON.parse(
    await readFile(join(options.cacheDirectory, "release-lock.json"), "utf8"),
  );
  expect(lock.version).toBe("v0.1.0");
  expect(lock.hostProtocol).toBe(1);
  expect((await stat(join(options.cacheDirectory, "release-lock.json"))).mode & 0o777).toBe(0o600);
  expect(
    await ensureOfficialSimulatorBinary(options, {
      ...deps,
      fetch: async () => {
        throw new Error("must not access network");
      },
    }),
  ).toBe(path);
});

test("explicit update advances only after verification and failure preserves old lock", async () => {
  const options = await setup();
  await ensureOfficialSimulatorBinary(options, transport());
  const lockPath = join(options.cacheDirectory, "release-lock.json");
  const old = await readFile(lockPath, "utf8");
  const broken = fixture("v0.2.0");
  broken.binary = "corrupt";
  await expect(
    ensureOfficialSimulatorBinary({ ...options, update: true }, transport([broken])),
  ).rejects.toThrow("checksum");
  expect(await readFile(lockPath, "utf8")).toBe(old);
  await ensureOfficialSimulatorBinary({ ...options, update: true }, transport([fixture("v0.2.0")]));
  expect(JSON.parse(await readFile(lockPath, "utf8")).version).toBe("v0.2.0");
  expect(
    (await readdir(options.cacheDirectory)).some(
      (name) => name.startsWith(".download") || name.startsWith(".lock-"),
    ),
  ).toBe(false);
});

test("no compatible release, changed same-version bytes and offline first use fail closed", async () => {
  const options = await setup();
  await expect(ensureOfficialSimulatorBinary(options, transport([]))).rejects.toThrow(
    "No compatible",
  );
  await expect(
    ensureOfficialSimulatorBinary(options, transport([fixture("v0.3.0", 2)])),
  ).rejects.toThrow("No compatible");
  await expect(
    ensureOfficialSimulatorBinary(options, {
      ...transport(),
      fetch: async () => {
        throw new Error("private details");
      },
    }),
  ).rejects.toThrow("connectivity");
  await ensureOfficialSimulatorBinary(options, transport());
  const changed = fixture();
  changed.manifest += " ";
  changed.sums = changed.sums.replace(hash(fixture().manifest), hash(changed.manifest));
  await expect(
    ensureOfficialSimulatorBinary({ ...options, update: true }, transport([changed])),
  ).rejects.toThrow("changed");
});

test("missing cached binary retrieves locked version without release discovery; corruption never falls back", async () => {
  const options = await setup();
  const deps = transport();
  const path = await ensureOfficialSimulatorBinary(options, deps);
  await rm(path);
  deps.requests.length = 0;
  await ensureOfficialSimulatorBinary(options, deps);
  expect(deps.requests.some((url) => url.includes("api.github.com"))).toBe(false);
  await writeFile(path, "corrupt");
  await expect(ensureOfficialSimulatorBinary(options, deps)).rejects.toThrow("checksum mismatch");
});

test("unsafe or malformed local locks are never overwritten", async () => {
  const options = await setup();
  await ensureOfficialSimulatorBinary(options, transport());
  const lock = join(options.cacheDirectory, "release-lock.json");
  await chmod(lock, 0o644);
  await expect(
    ensureOfficialSimulatorBinary({ ...options, update: true }, transport()),
  ).rejects.toThrow("Unsafe");
  await chmod(lock, 0o600);
  await writeFile(lock, "{}");
  await expect(ensureOfficialSimulatorBinary(options, transport())).rejects.toThrow("invalid");
});

test("incompatible newer release is skipped and platform selection shares the local version lock", async () => {
  const options = await setup();
  const deps = transport([fixture("v0.3.0", 2), fixture("v0.2.0")]);
  expect(await ensureOfficialSimulatorBinary(options, deps)).toEndWith(
    "v0.2.0-tenkacloud-simulator_linux_amd64",
  );
  expect(
    await ensureOfficialSimulatorBinary(options, { ...deps, platform: "darwin", arch: "arm64" }),
  ).toEndWith("v0.2.0-tenkacloud-simulator_darwin_arm64");
});

test("concurrent acquisition refuses a second writer and releases the mutex after failure", async () => {
  const options = await setup();
  const deps = transport();
  let started!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = ensureOfficialSimulatorBinary(options, {
    ...deps,
    fetch: async (url, init) => {
      started();
      await gate;
      return deps.fetch(url, init);
    },
  });
  await entered;
  await expect(ensureOfficialSimulatorBinary(options, deps)).rejects.toThrow("already active");
  resume();
  await first;
  expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
});

test("duplicate checksums and tampered BUILDINFO never publish a lock or binary", async () => {
  for (const kind of ["duplicate", "manifest", "missing-target"]) {
    const options = await setup();
    const release = fixture();
    if (kind === "duplicate") release.sums += release.sums.split("\n")[0] + "\n";
    if (kind === "manifest") release.manifest += " ";
    if (kind === "missing-target")
      release.sums = release.sums
        .split("\n")
        .filter((line) => !line.includes("darwin_arm64"))
        .join("\n");
    await expect(ensureOfficialSimulatorBinary(options, transport([release]))).rejects.toThrow(
      "Simulator",
    );
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("discovery ignores prereleases and drafts and chooses semantic version order", async () => {
  const options = await setup();
  const deps = transport([fixture("v0.9.0"), fixture("v0.10.0")]);
  const fetch = async (url: string, init: RequestInit) =>
    url.includes("api.github.com")
      ? Response.json([
          { tag_name: "v9.0.0", draft: true, prerelease: false },
          { tag_name: "v8.0.0-rc.1", draft: false, prerelease: true },
          { tag_name: "../../escape", draft: false, prerelease: false },
          { tag_name: "v0.9.0", draft: false, prerelease: false },
          { tag_name: "v0.10.0", draft: false, prerelease: false },
        ])
      : deps.fetch(url, init);
  expect(await ensureOfficialSimulatorBinary(options, { ...deps, fetch })).toContain("v0.10.0");
});

test("explicit update never downgrades and aborted metadata acquisition leaves the lock intact", async () => {
  const options = await setup();
  await ensureOfficialSimulatorBinary(options, transport([fixture("v0.2.0")]));
  const before = await readFile(join(options.cacheDirectory, "release-lock.json"), "utf8");
  await expect(
    ensureOfficialSimulatorBinary({ ...options, update: true }, transport()),
  ).rejects.toThrow("downgrade");
  const fetch = async (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("private-token")), {
        once: true,
      });
    });
  await expect(
    ensureOfficialSimulatorBinary(
      { ...options, update: true },
      { ...transport(), fetch, timeoutMs: 10 },
    ),
  ).rejects.toThrow("timed out");
  expect(await readFile(join(options.cacheDirectory, "release-lock.json"), "utf8")).toBe(before);
  expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
});

test("metadata timeout interrupts a pending response-body read and releases the operation lock", async () => {
  const options = await setup();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  const pending = ensureOfficialSimulatorBinary(options, {
    ...transport(),
    timeoutMs: 10,
    fetch: async () => new Response(body),
  });
  try {
    const outcome = await Promise.race([
      pending.then(
        () => "unexpected success",
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 100)),
    ]);
    expect(outcome).toContain("timed out");
  } finally {
    try {
      stream.close();
    } catch {
      /* Cancellation may have already closed the fixture. */
    }
    await pending.catch(() => {
      /* Expected refusal; allow cleanup before teardown. */
    });
  }
  expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
});

test("unsafe linked, directory and oversized local locks are refused without network or replacement", async () => {
  for (const kind of ["symlink", "hardlink", "directory", "oversized"]) {
    const options = await setup();
    await ensureOfficialSimulatorBinary(options, transport());
    const path = join(options.cacheDirectory, "release-lock.json");
    const original = await readFile(path, "utf8");
    const target = join(options.cacheDirectory, "original.json");
    await writeFile(target, original, { mode: 0o600 });
    await rm(path);
    if (kind === "symlink") await symlink(target, path);
    if (kind === "hardlink") await link(target, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "oversized") await writeFile(path, " ".repeat(16_385), { mode: 0o600 });
    await expect(
      ensureOfficialSimulatorBinary(
        { ...options, update: true },
        {
          ...transport(),
          fetch: async () => {
            throw new Error("must not fetch");
          },
        },
      ),
    ).rejects.toThrow("Unsafe Simulator release lock");
    expect(await readFile(target, "utf8")).toBe(original);
    expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
  }
});
