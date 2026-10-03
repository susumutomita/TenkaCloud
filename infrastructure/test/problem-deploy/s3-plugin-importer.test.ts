import { describe, expect, it, vi } from "vitest";
import {
  coordinationPluginS3Key,
  createS3PluginImporter,
  pluginBundleDigest,
} from "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/s3-plugin-importer";
import { loadCoordinationPlugin } from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader";

/**
 * Issue #1420: S3 plugin importer。mock S3 が返す self-contained .mjs を /tmp に
 * 書き出して dynamic import し、 純 reducer の contract を満たすことを e2e で pin する。
 */
const PLUGIN_JS =
  "export default { initialState: () => ({ count: 0 }), " +
  "validateOp: () => ({ ok: true }), applyOp: (s) => s, projectForTeam: (s) => s };\n";

function mockS3(body: string | undefined) {
  return {
    send: vi
      .fn()
      .mockResolvedValue(
        body === undefined ? {} : { Body: { transformToString: async () => body } },
      ),
  };
}

describe("coordinationPluginS3Key", () => {
  it("should key by coordination/<moduleRef>.mjs", () => {
    expect(coordinationPluginS3Key("ms-battle")).toBe("coordination/ms-battle.mjs");
  });
});

describe("createS3PluginImporter", () => {
  it("should download, write, and dynamically import a valid plugin", async () => {
    const s3 = mockS3(PLUGIN_JS);
    const importer = createS3PluginImporter({ s3, bucket: "B" });
    const load = await loadCoordinationPlugin(importer, "ms-battle");
    expect(load.kind).toBe("ok");
    expect(typeof (load.kind === "ok" ? load.plugin.initialState : undefined)).toBe("function");
    const cmd = s3.send.mock.calls[0][0] as { input: { Bucket: string; Key: string } };
    expect(cmd.input).toMatchObject({ Bucket: "B", Key: "coordination/ms-battle.mjs" });
  });

  it("should cache per moduleRef (no re-download on a warm invoke)", async () => {
    const s3 = mockS3(PLUGIN_JS);
    const importer = createS3PluginImporter({ s3, bucket: "B" });
    await importer("p1");
    await importer("p1");
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it("should throw and evict the cache when the object is empty (next invoke retries)", async () => {
    const s3 = mockS3("");
    const importer = createS3PluginImporter({ s3, bucket: "B" });
    await expect(importer("p1")).rejects.toThrow(/not found or empty/);
    await expect(importer("p1")).rejects.toThrow();
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  it("should throw when S3 returns no Body", async () => {
    const s3 = mockS3(undefined);
    const importer = createS3PluginImporter({ s3, bucket: "B" });
    await expect(importer("p1")).rejects.toThrow(/not found or empty/);
  });
});

describe("createS3PluginImporter digest integrity", () => {
  it("should compute a sha256:<hex> digest of the bundle bytes", () => {
    expect(pluginBundleDigest(PLUGIN_JS)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pluginBundleDigest(PLUGIN_JS)).toBe(pluginBundleDigest(PLUGIN_JS));
    expect(pluginBundleDigest(PLUGIN_JS)).not.toBe(pluginBundleDigest(`${PLUGIN_JS}// tampered`));
  });

  it("should import when the resolved expected digest matches", async () => {
    const s3 = mockS3(PLUGIN_JS);
    const importer = createS3PluginImporter({
      s3,
      bucket: "B",
      resolveExpectedDigest: () => pluginBundleDigest(PLUGIN_JS),
    });
    expect((await loadCoordinationPlugin(importer, "ms-battle")).kind).toBe("ok");
  });

  it("should fail closed (throw, no import) when the digest does not match the bytes", async () => {
    // S3 bucket / publish 経路の改ざんを模す: 期待 digest と download bytes が食い違う。
    const tamperedBody = `${PLUGIN_JS}globalThis.__pwned = true;\n`;
    const s3 = mockS3(tamperedBody);
    const importer = createS3PluginImporter({
      s3,
      bucket: "B",
      resolveExpectedDigest: () => pluginBundleDigest(PLUGIN_JS),
    });
    await expect(importer("ms-battle")).rejects.toThrow(/digest mismatch/);
    // loader 経由なら fail-closed で null (= plugin_unavailable)。
    const s3b = mockS3(tamperedBody);
    const importerB = createS3PluginImporter({
      s3: s3b,
      bucket: "B",
      resolveExpectedDigest: () => pluginBundleDigest(PLUGIN_JS),
    });
    // [Issue #3150] digest 不一致は import が throw する = 「plugin が無い」側。
    // 版宣言の違反 (`invalid_schema`) とは別物であることをここでも固定する。
    expect(await loadCoordinationPlugin(importerB, "ms-battle")).toEqual({ kind: "unavailable" });
  });

  it("should skip verification when the resolver returns undefined (module not pinned)", async () => {
    const s3 = mockS3(PLUGIN_JS);
    const importer = createS3PluginImporter({
      s3,
      bucket: "B",
      resolveExpectedDigest: () => undefined,
    });
    expect((await loadCoordinationPlugin(importer, "ms-battle")).kind).toBe("ok");
  });
});
