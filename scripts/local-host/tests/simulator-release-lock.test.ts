import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOfficialSimulatorBinary } from "../simulator-release-lock";

const releaseListUrl =
  "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases?per_page=100";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "simulator-lock-test-")));
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
    if (url === releaseListUrl)
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
  expect(deps.requests.some((url) => url === releaseListUrl)).toBe(false);
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
    url === releaseListUrl
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

const releaseApi = "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases";
function apiFallback(release = fixture("v0.2.0"), status = 504, name = "BUILDINFO.json") {
  const base = transport([release]);
  const download = `https://github.com/susumutomita/TenkaCloudSimulator/releases/download/${release.version}/${name}`;
  const tagUrl = `${releaseApi}/tags/${release.version}`;
  const assetUrl = `${releaseApi}/assets/123456`;
  const redirect =
    "https://release-assets.githubusercontent.com/github-production-release-asset/fixture";
  const metadata = {
    tag_name: release.version,
    draft: false,
    prerelease: false,
    assets: [
      { id: 123456, name, url: assetUrl, browser_download_url: download, state: "uploaded" },
    ],
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url === download) return new Response("gateway failure", { status });
    if (url === tagUrl) return Response.json(metadata);
    if (url === assetUrl)
      return new Response(null, { status: 302, headers: { location: redirect } });
    if (url === redirect)
      return new Response(name === "SHA256SUMS" ? release.sums : release.manifest);
    return base.fetch(url, init);
  };
  return { ...base, fetch, requests, metadata, download, tagUrl, assetUrl, redirect };
}

test("transient metadata gateway failures recover once through the exact official release asset API", async () => {
  for (const status of [502, 503, 504]) {
    for (const name of ["SHA256SUMS", "BUILDINFO.json"]) {
      const options = await setup();
      const deps = apiFallback(fixture("v0.2.0"), status, name);
      const binary = await ensureOfficialSimulatorBinary(options, deps);
      expect(await readFile(binary, "utf8")).toBe(fixture("v0.2.0").binary);
      expect(deps.requests.filter((r) => r.url === deps.assetUrl)).toHaveLength(1);
      expect(deps.requests.filter((r) => r.url === deps.tagUrl)).toHaveLength(1);
      for (const request of deps.requests) {
        expect(request.init.credentials).toBe("omit");
        expect(request.init.redirect).toBe("manual");
        expect(new Headers(request.init.headers).has("authorization")).toBe(false);
        if (request.url === deps.assetUrl)
          expect(new Headers(request.init.headers).get("accept")).toBe("application/octet-stream");
      }
      const lock = JSON.parse(
        await readFile(join(options.cacheDirectory, "release-lock.json"), "utf8"),
      );
      expect(lock.version).toBe("v0.2.0");
      expect(lock.buildInfoSha256).toBe(hash(fixture("v0.2.0").manifest));
    }
  }
});

test("metadata denials, missing assets and nontransient failures never invoke recovery", async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 501]) {
    const options = await setup();
    const deps = apiFallback(fixture(), status);
    await expect(ensureOfficialSimulatorBinary(options, deps)).rejects.toThrow(`HTTP ${status}`);
    expect(deps.requests.some((r) => r.url === deps.tagUrl || r.url === deps.assetUrl)).toBe(false);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("recovery validates release tag, publication state, unique asset and both official URLs", async () => {
  type Metadata = ReturnType<typeof apiFallback>["metadata"];
  const invalidReleases: Partial<Metadata>[] = [
    { tag_name: "v8.0.0" },
    { draft: true },
    { prerelease: true },
    { assets: [] },
  ];
  const original = apiFallback().metadata.assets[0];
  if (!original) throw new Error("Missing test asset");
  const invalidAssets = [
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { state: "new" },
    { url: "https://example.com/asset" },
    { browser_download_url: original.browser_download_url.replace("v0.2.0", "v9.0.0") },
  ];
  invalidReleases.push({ assets: [original, original] });
  invalidReleases.push(...invalidAssets.map((asset) => ({ assets: [{ ...original, ...asset }] })));
  for (const changes of invalidReleases) {
    const options = await setup();
    const deps = apiFallback();
    Object.assign(deps.metadata, changes);
    await expect(ensureOfficialSimulatorBinary(options, deps)).rejects.toThrow(
      "Simulator release asset API",
    );
    expect(deps.requests.some((r) => r.url === deps.assetUrl)).toBe(false);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("failed recovery does not retry, select an older release, or replace the existing lock", async () => {
  for (const target of ["tagUrl", "assetUrl"] as const) {
    for (const status of [403, 404, 429, 504]) {
      const options = await setup();
      await ensureOfficialSimulatorBinary(options, transport());
      const lock = join(options.cacheDirectory, "release-lock.json");
      const before = await readFile(lock, "utf8");
      const deps = apiFallback(fixture("v0.2.0"), 504, "SHA256SUMS");
      const calls: string[] = [];
      await expect(
        ensureOfficialSimulatorBinary(
          { ...options, update: true },
          {
            ...deps,
            fetch: async (url, init) => {
              calls.push(url);
              if (url === deps[target]) return new Response(null, { status });
              return deps.fetch(url, init);
            },
          },
        ),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(calls.filter((url) => url === deps[target])).toHaveLength(1);
      expect(await readFile(lock, "utf8")).toBe(before);
      expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
    }
  }
});

test("recovered BUILDINFO still enforces checksum, source identity and protocol compatibility", async () => {
  for (const [change, expected] of [
    [{}, "checksum"],
    [{ source_repository: "https://github.com/other/repository" }, "metadata is invalid"],
    [{ version: "v0.1.0" }, "metadata is invalid"],
    [{ source_commit: "invalid" }, "metadata is invalid"],
    [{ host_protocol: 2 }, "No compatible"],
  ] as const) {
    const options = await setup();
    const release = fixture("v0.2.0");
    release.manifest = `${JSON.stringify({ ...JSON.parse(release.manifest), ...change })} `;
    if (expected !== "checksum")
      release.sums = release.sums.replace(hash(fixture("v0.2.0").manifest), hash(release.manifest));
    await expect(ensureOfficialSimulatorBinary(options, apiFallback(release))).rejects.toThrow(
      expected,
    );
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("recovery retains immutable-version and downgrade protections", async () => {
  for (const kind of ["immutable", "downgrade"]) {
    const options = await setup();
    await ensureOfficialSimulatorBinary(options, transport([fixture("v0.2.0")]));
    const path = join(options.cacheDirectory, "release-lock.json");
    const before = await readFile(path, "utf8");
    const release = fixture(kind === "downgrade" ? "v0.1.0" : "v0.2.0");
    release.manifest += " ";
    release.sums = release.sums.replace(
      hash(fixture(release.version).manifest),
      hash(release.manifest),
    );
    await expect(
      ensureOfficialSimulatorBinary({ ...options, update: true }, apiFallback(release)),
    ).rejects.toThrow(kind === "downgrade" ? "downgrade" : "changed for the same version");
    expect(await readFile(path, "utf8")).toBe(before);
  }
});

test("recovery enforces trusted redirects, redirect count and bounded metadata bodies", async () => {
  const deps = apiFallback();
  const redirectResponse = (location: string) => () =>
    new Response(null, { status: 302, headers: { location } });
  const insecure = new URL("https://github.com/asset");
  insecure.protocol = "http:";
  const cases: [() => Response, string][] = [
    [redirectResponse("https://example.com/asset"), "redirect"],
    [redirectResponse(insecure.href), "redirect"],
    [redirectResponse("https://user:secret@github.com/asset"), "redirect"],
    [redirectResponse("https://github.com:444/asset"), "redirect"],
    [redirectResponse(deps.redirect), "redirect"],
    [() => new Response(" ".repeat(65_537)), "size limit"],
    [() => Response.json({ message: "not asset bytes" }), "checksum"],
  ];
  for (const [response, expected] of cases) {
    const options = await setup();
    await expect(
      ensureOfficialSimulatorBinary(options, {
        ...deps,
        fetch: async (url, init) => {
          if (url === deps.assetUrl || url === deps.redirect) return response();
          return deps.fetch(url, init);
        },
      }),
    ).rejects.toThrow(expected);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("recovery shares the resolution deadline and cleans up after a stalled API asset body", async () => {
  const options = await setup();
  const deps = apiFallback();
  await expect(
    ensureOfficialSimulatorBinary(options, {
      ...deps,
      timeoutMs: 20,
      fetch: async (url, init) =>
        url === deps.assetUrl
          ? new Response(new ReadableStream<Uint8Array>())
          : deps.fetch(url, init),
    }),
  ).rejects.toThrow("timed out");
  const signals = deps.requests.map((r) => r.init.signal);
  expect(signals.every((signal) => signal === signals[0])).toBe(true);
  expect(await readdir(options.cacheDirectory)).toEqual([]);
});

test("a nonsettling gateway-body cancellation cannot stall metadata recovery", async () => {
  const options = await setup();
  const deps = apiFallback();
  let cancelled = false;
  const pending = ensureOfficialSimulatorBinary(options, {
    ...deps,
    timeoutMs: 100,
    fetch: async (url, init) =>
      url === deps.download
        ? new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
                return new Promise<void>(() => {
                  /* Deliberately never settles. */
                });
              },
            }),
            { status: 504 },
          )
        : deps.fetch(url, init),
  });
  const result = await Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 250)),
  ]);
  expect(result).toContain("v0.2.0-tenkacloud-simulator_linux_amd64");
  expect(cancelled).toBe(true);
  expect(await readdir(options.cacheDirectory)).not.toContain(".release-operation");
});

test("binary API recovery updates lock only after verified bytes; failures preserve old lock and binary", async () => {
  for (const corrupt of [false, true]) {
    const options = await setup();
    const oldBinary = await ensureOfficialSimulatorBinary(options, transport());
    const lockPath = join(options.cacheDirectory, "release-lock.json");
    const oldLock = await readFile(lockPath);
    const selected = fixture("v0.2.0");
    const deps = transport([selected]);
    const name = "tenkacloud-simulator_linux_amd64";
    const url = `https://github.com/susumutomita/TenkaCloudSimulator/releases/download/${selected.version}/${name}`;
    const api = "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases";
    const fetch = async (target: string, init: RequestInit) => {
      if (target === url) return new Response("gateway", { status: 504 });
      if (target === `${api}/tags/${selected.version}`)
        return Response.json({
          tag_name: selected.version,
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 321,
              name,
              state: "uploaded",
              browser_download_url: url,
              url: `${api}/assets/321`,
            },
          ],
        });
      if (target === `${api}/assets/321`)
        return new Response(corrupt ? "corrupt" : selected.binary);
      return deps.fetch(target, init);
    };
    const operation = ensureOfficialSimulatorBinary(
      { ...options, update: true },
      { ...deps, fetch },
    );
    if (corrupt) {
      await expect(operation).rejects.toThrow("checksum mismatch");
      expect(await readFile(lockPath)).toEqual(oldLock);
      expect((await readdir(options.cacheDirectory)).sort()).toEqual([
        "release-lock.json",
        "v0.1.0-tenkacloud-simulator_linux_amd64",
      ]);
    } else {
      expect(await readFile(await operation, "utf8")).toBe(selected.binary);
      expect(JSON.parse(await readFile(lockPath, "utf8")).version).toBe(selected.version);
    }
    expect(await readFile(oldBinary, "utf8")).toBe(fixture().binary);
  }
});
