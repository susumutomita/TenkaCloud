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
import { ensureSimulatorBinary, type SimulatorRelease } from "../simulator-release";

const bytes = new TextEncoder().encode("test fixture, never executed");
const checksum = createHash("sha256").update(bytes).digest("hex");
const release: SimulatorRelease = {
  version: "v0.1.0",
  checksums: {
    "tenkacloud-simulator_linux_amd64": checksum,
    "tenkacloud-simulator_linux_arm64": checksum,
    "tenkacloud-simulator_darwin_amd64": checksum,
    "tenkacloud-simulator_darwin_arm64": checksum,
  },
};
const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "simulator-release-test-")));
  roots.push(root);
  const cacheDirectory = join(root, "cache");
  return { root, cacheDirectory, release };
}
function downloader(response: () => Response = () => new Response(bytes)) {
  return async () => response();
}
const platform = { platform: "linux", arch: "x64" };

test("downloads only official pinned URL, verifies, installs privately, reuses offline", async () => {
  const options = await setup();
  let requested = "";
  const fetcher = async (url: string, init: RequestInit) => {
    requested = url;
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    return new Response(bytes);
  };
  const binary = await ensureSimulatorBinary(options, { ...platform, fetch: fetcher });
  expect(requested).toBe(
    "https://github.com/susumutomita/TenkaCloudSimulator/releases/download/v0.1.0/tenkacloud-simulator_linux_amd64",
  );
  expect(await readFile(binary)).toEqual(Buffer.from(bytes));
  expect((await stat(binary)).mode & 0o777).toBe(0o700);
  expect((await stat(binary)).nlink).toBe(1);
  expect(await readdir(options.cacheDirectory)).toEqual([
    "v0.1.0-tenkacloud-simulator_linux_amd64",
  ]);
  expect(
    await ensureSimulatorBinary(options, {
      ...platform,
      fetch: downloader(() => {
        throw new Error("offline");
      }),
    }),
  ).toBe(binary);
});

test("rejects corrupt cache without downloading or replacing it", async () => {
  const options = await setup();
  const binary = await ensureSimulatorBinary(options, { ...platform, fetch: downloader() });
  await writeFile(binary, "corrupt");
  await expect(
    ensureSimulatorBinary(options, {
      ...platform,
      fetch: downloader(() => {
        throw new Error("must not fetch");
      }),
    }),
  ).rejects.toThrow("cache checksum mismatch");
  expect(await readFile(binary, "utf8")).toBe("corrupt");
});

test("checksum mismatch and HTTP failure leave no binary or download files, allowing retry", async () => {
  for (const response of [
    () => new Response("wrong"),
    () => new Response("private body", { status: 404 }),
  ]) {
    const options = await setup();
    await expect(
      ensureSimulatorBinary(options, { ...platform, fetch: downloader(response) }),
    ).rejects.toThrow("Simulator");
    expect(await readdir(options.cacheDirectory)).toEqual([]);
    await ensureSimulatorBinary(options, { ...platform, fetch: downloader() });
  }
});

test("rejects oversized declared and streamed bodies and empty payloads", async () => {
  for (const response of [
    () => new Response(bytes, { headers: { "content-length": "500" } }),
    () => new Response(bytes),
    () => new Response(""),
  ]) {
    const options = await setup();
    await expect(
      ensureSimulatorBinary(options, { ...platform, fetch: downloader(response), maxBytes: 10 }),
    ).rejects.toThrow("Simulator");
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("rejects unsupported platforms, path-like tags and missing checksum before fetch", async () => {
  const options = await setup();
  const fetcher = downloader(() => {
    throw new Error("must not fetch");
  });
  await expect(
    ensureSimulatorBinary(options, { platform: "win32", fetch: fetcher }),
  ).rejects.toThrow("support only");
  await expect(
    ensureSimulatorBinary(
      { ...options, release: { ...release, version: "../../escape" } },
      { ...platform, fetch: fetcher },
    ),
  ).rejects.toThrow("semantic");
  await expect(
    ensureSimulatorBinary(
      {
        ...options,
        release: {
          ...release,
          checksums: { ...release.checksums, "tenkacloud-simulator_linux_amd64": "" },
        },
      },
      { ...platform, fetch: fetcher },
    ),
  ).rejects.toThrow("trusted SHA-256");
});

test("supports all four release assets", async () => {
  for (const os of ["linux", "darwin"])
    for (const arch of ["x64", "arm64"]) {
      const options = await setup();
      const binary = await ensureSimulatorBinary(options, {
        platform: os,
        arch,
        fetch: downloader(),
      });
      expect(binary).toEndWith(`tenkacloud-simulator_${os}_${arch === "x64" ? "amd64" : arch}`);
    }
});

test("refuses symlink cache directories and symlink ancestors", async () => {
  const options = await setup();
  const target = join(options.root, "target");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, options.cacheDirectory);
  await expect(
    ensureSimulatorBinary(options, { ...platform, fetch: downloader() }),
  ).rejects.toThrow("private directory");
  await expect(
    ensureSimulatorBinary(
      { ...options, cacheDirectory: join(options.cacheDirectory, "nested") },
      { ...platform, fetch: downloader() },
    ),
  ).rejects.toThrow("symlinks");
});

test("refuses cache files with symlinks, hardlinks, nonregular types or unsafe permissions", async () => {
  for (const kind of ["symlink", "hardlink", "directory", "permissions"]) {
    const options = await setup();
    await mkdir(options.cacheDirectory, { mode: 0o700 });
    const target = join(options.root, "target");
    await writeFile(target, bytes, { mode: 0o700 });
    const binary = join(options.cacheDirectory, "v0.1.0-tenkacloud-simulator_linux_amd64");
    if (kind === "symlink") await symlink(target, binary);
    if (kind === "hardlink") await link(target, binary);
    if (kind === "directory") await mkdir(binary);
    if (kind === "permissions") {
      await writeFile(binary, bytes, { mode: 0o700 });
      // Other host tests intentionally set umask(077); make this unsafe fixture explicit.
      await chmod(binary, 0o755);
    }
    await expect(
      ensureSimulatorBinary(options, { ...platform, fetch: downloader() }),
    ).rejects.toThrow("Unsafe simulator cache file");
    expect(await readFile(target)).toEqual(Buffer.from(bytes));
  }
});

test("does not repair or adopt an insecure cache directory", async () => {
  const options = await setup();
  await mkdir(options.cacheDirectory);
  await chmod(options.cacheDirectory, 0o777);
  await expect(
    ensureSimulatorBinary(options, { ...platform, fetch: downloader() }),
  ).rejects.toThrow("private directory");
  expect((await stat(options.cacheDirectory)).mode & 0o777).toBe(0o777);
});

test("follows official release CDN redirects but rejects outside hosts", async () => {
  const options = await setup();
  let requests = 0;
  const fetcher = downloader(() =>
    ++requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/test" },
        })
      : new Response(bytes),
  );
  await ensureSimulatorBinary(options, { ...platform, fetch: fetcher });
  expect(requests).toBe(2);
  const other = await setup();
  await expect(
    ensureSimulatorBinary(other, {
      ...platform,
      fetch: downloader(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/binary" },
          }),
      ),
    }),
  ).rejects.toThrow("trusted GitHub");
});

test("cancellation and timeout clean up and sanitize private fetch errors", async () => {
  for (const timeout of [false, true]) {
    const options = await setup();
    const controller = new AbortController();
    const fetcher = async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("private-token")), {
          once: true,
        });
        if (!timeout) controller.abort();
      });
    await expect(
      ensureSimulatorBinary(
        { ...options, signal: controller.signal },
        { ...platform, fetch: fetcher, timeoutMs: 10 },
      ),
    ).rejects.toThrow("cancelled or timed out");
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
  const options = await setup();
  await expect(
    ensureSimulatorBinary(options, {
      ...platform,
      fetch: downloader(() => {
        throw new Error("private-token");
      }),
    }),
  ).rejects.toThrow("check connectivity");
});

test("pending binary read and nonsettling cancellation cannot prevent timeout cleanup", async () => {
  const options = await setup();
  const body = new ReadableStream<Uint8Array>({
    cancel: () =>
      new Promise<void>(() => {
        /* Simulate an uncooperative underlying stream. */
      }),
  });
  const pending = ensureSimulatorBinary(options, {
    ...platform,
    timeoutMs: 10,
    fetch: async () => new Response(body),
  });
  const outcome = await Promise.race([
    pending.then(
      () => "unexpected success",
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  expect(outcome).toContain("timed out");
  expect(await readdir(options.cacheDirectory)).toEqual([]);
});

const api = "https://api.github.com/repos/susumutomita/TenkaCloudSimulator/releases";
const binaryName = "tenkacloud-simulator_linux_amd64";
const downloadUrl = `https://github.com/susumutomita/TenkaCloudSimulator/releases/download/${release.version}/${binaryName}`;
function assetMetadata() {
  return {
    tag_name: release.version,
    draft: false,
    prerelease: false,
    assets: [
      {
        id: 123,
        name: binaryName,
        state: "uploaded",
        url: `${api}/assets/123`,
        browser_download_url: downloadUrl,
      },
    ],
  };
}
function firstAsset(info: ReturnType<typeof assetMetadata>) {
  const asset = info.assets[0];
  if (!asset) throw new Error("fixture asset missing");
  return asset;
}
function fallbackTransport(
  options: { primary?: () => Response; metadata?: () => Response; binary?: () => Response } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    fetch: async (url: string, init: RequestInit) => {
      calls.push(url);
      if (init.signal) signals.push(init.signal);
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("manual");
      if (url === downloadUrl)
        return options.primary?.() ?? new Response("gateway", { status: 504 });
      if (url === `${api}/tags/${release.version}`) {
        expect(init.headers).toBeUndefined();
        return options.metadata?.() ?? Response.json(assetMetadata());
      }
      expect(url).toBe(`${api}/assets/123`);
      expect(init.headers).toEqual({ Accept: "application/octet-stream" });
      return options.binary?.() ?? new Response(bytes);
    },
  };
}

test("binary gateway failures recover once through the exact official asset with the same deadline", async () => {
  for (const status of [502, 503, 504]) {
    const options = await setup();
    const deps = fallbackTransport({ primary: () => new Response("gateway", { status }) });
    const path = await ensureSimulatorBinary(options, { ...platform, ...deps });
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(deps.calls).toEqual([
      downloadUrl,
      `${api}/tags/${release.version}`,
      `${api}/assets/123`,
    ]);
    expect(new Set(deps.signals).size).toBe(1);
  }
});

test("binary failures other than transient gateways never attempt API recovery", async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 501]) {
    const options = await setup();
    const deps = fallbackTransport({ primary: () => new Response("private", { status }) });
    await expect(ensureSimulatorBinary(options, { ...platform, ...deps })).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(deps.calls).toEqual([downloadUrl]);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("binary fallback rejects ambiguous, spoofed, incomplete, or unsafe official asset identities", async () => {
  const mutations: ((info: ReturnType<typeof assetMetadata>) => void)[] = [
    (info) => {
      info.tag_name = "v9.0.0";
    },
    (info) => {
      info.draft = true;
    },
    (info) => {
      info.prerelease = true;
    },
    (info) => {
      info.assets.push({ ...firstAsset(info) });
    },
    (info) => {
      firstAsset(info).name = "wrong";
    },
    (info) => {
      firstAsset(info).state = "new";
    },
    (info) => {
      firstAsset(info).id = -1;
    },
    (info) => {
      firstAsset(info).id = 1.5;
    },
    (info) => {
      firstAsset(info).id = Number.MAX_SAFE_INTEGER + 1;
    },
    (info) => {
      firstAsset(info).url = "https://evil.example/assets/123";
    },
    (info) => {
      firstAsset(info).browser_download_url = `${downloadUrl}?spoof=1`;
    },
  ];
  for (const mutate of mutations) {
    const options = await setup();
    const info = assetMetadata();
    mutate(info);
    const deps = fallbackTransport({ metadata: () => Response.json(info) });
    await expect(ensureSimulatorBinary(options, { ...platform, ...deps })).rejects.toThrow(
      "asset API",
    );
    expect(deps.calls.length).toBe(2);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("binary recovery keeps checksum, length, streamed bounds, and one-attempt enforcement", async () => {
  for (const binary of [
    () => new Response("wrong hash"),
    () => new Response(null),
    () => new Response(bytes, { headers: { "content-length": "999" } }),
    () => new Response(new Uint8Array(999)),
    () => new Response("gateway again", { status: 504 }),
    () => new Response("missing", { status: 404 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/?secret=private" },
      }),
  ]) {
    const options = await setup();
    const deps = fallbackTransport({ binary });
    await expect(
      ensureSimulatorBinary(options, { ...platform, ...deps, maxBytes: 100 }),
    ).rejects.toThrow("Simulator");
    expect(deps.calls.length).toBe(3);
    expect(await readdir(options.cacheDirectory)).toEqual([]);
  }
});

test("binary API metadata and body obey cancellation, deadline, and metadata size limits", async () => {
  for (const phase of ["metadata", "binary"] as const) {
    for (const cancel of [false, true]) {
      const options = await setup();
      const controller = new AbortController();
      const deps = fallbackTransport({
        [phase]: () =>
          new Response(
            new ReadableStream({
              start() {
                if (cancel) controller.abort();
              },
              cancel() {
                return new Promise(() => {
                  /* Intentionally ignore cancellation settlement. */
                });
              },
            }),
          ),
      });
      await expect(
        ensureSimulatorBinary(
          { ...options, signal: controller.signal },
          {
            ...platform,
            ...deps,
            timeoutMs: 20,
          },
        ),
      ).rejects.toThrow("cancelled or timed out");
      expect(await readdir(options.cacheDirectory)).toEqual([]);
    }
  }
  const options = await setup();
  const deps = fallbackTransport({ metadata: () => new Response(" ".repeat(2 * 1024 * 1024 + 1)) });
  await expect(ensureSimulatorBinary(options, { ...platform, ...deps })).rejects.toThrow(
    "metadata exceeds",
  );
  expect(deps.calls.length).toBe(2);
  expect(await readdir(options.cacheDirectory)).toEqual([]);
});

test("binary recovery is not blocked by nonsettling gateway cancellation", async () => {
  const options = await setup();
  const deps = fallbackTransport({
    primary: () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {
              /* Intentionally ignore cancellation settlement. */
            });
          },
        }),
        { status: 504 },
      ),
  });
  const path = await ensureSimulatorBinary(options, { ...platform, ...deps, timeoutMs: 100 });
  expect(await readFile(path)).toEqual(Buffer.from(bytes));
});
