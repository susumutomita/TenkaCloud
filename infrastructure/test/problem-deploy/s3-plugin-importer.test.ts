import { describe, expect, it, vi } from "vitest";
import {
  coordinationPluginS3Key,
  createS3PluginImporter,
} from "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/s3-plugin-importer";
import { loadCoordinationPlugin } from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader";

/**
 * ADR-030 Phase 3b (#1420): S3 plugin importer。 mock S3 が返す self-contained .mjs を /tmp に
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
    const plugin = await loadCoordinationPlugin(importer, "ms-battle");
    expect(plugin).not.toBeNull();
    expect(typeof plugin?.initialState).toBe("function");
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
