import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PluginImporter } from "../participant-handler/coordination-plugin-loader.js";

/**
 * Issue #1420: coordination plugin の実 importer。
 *
 * 動的 load の対象は、レビュー済みカタログから synth 時に esbuild で self-contained .mjs へ
 * bundle し、S3 へ upload した coordination plugin に限定する。dispatcher Lambda はその bundle を
 * runtime に download して dynamic import する。この import は sandbox ではなく、plugin は Lambda の
 * environment と execution role を共有する。DynamoDB backend では Deployments table 全体への
 * Query / GetItem / PutItem と GSI2 全体への Query 権限も共有し、plugin 単位・tenant 単位の IAM
 * isolation はない。
 * そのため catalog review と publish control が plugin の trust boundary になる。
 *
 * `moduleRef` は problem id (= scope resolver が解決した一意キー)。 S3 key は `coordination/<id>.mjs`。
 * 同 Lambda 実行内では module-level cache で再 download / 再 import を避ける (= plugin は event 中 immutable)。
 */
export interface S3PluginImporterDeps {
  readonly s3: Pick<S3Client, "send">;
  readonly bucket: string;
  /**
   * 整合性 seam (artifact-digest 方針を plugin load に流用)。 `import` する前に
   * download した bundle bytes の digest を期待値と照合する。
   *   - `sha256:<hex>` を返す → 検証する。 不一致なら throw (= loader が plugin_unavailable に
   *     fail-closed)。 plugin bucket / publish 経路が改ざんされても任意コード実行を遮断する。
   *   - `undefined` を返す → 当該 module は未 pin として検証を skip (= resolver が per-module 判断)。
   *   - hook 自体を渡さない → 検証なし (後方互換: 既存挙動を変えない)。
   * 期待 digest の供給元 (= 署名付き manifest) の配線は publish パイプライン側の follow-up。
   */
  readonly resolveExpectedDigest?: (
    moduleRef: string,
  ) => string | undefined | Promise<string | undefined>;
}

export function coordinationPluginS3Key(moduleRef: string): string {
  return `coordination/${moduleRef}.mjs`;
}

/** bundle bytes の `sha256:<hex>` digest。 artifact digest と同形式。 */
export function pluginBundleDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 本番用 factory: 既定 S3Client を構築して importer を返す (= handler から SDK を直接触らせない seam)。 */
export function defaultS3PluginImporter(bucket: string): PluginImporter {
  return createS3PluginImporter({ s3: new S3Client({}), bucket });
}

export function createS3PluginImporter(deps: S3PluginImporterDeps): PluginImporter {
  const cache = new Map<string, Promise<unknown>>();
  return (moduleRef) => {
    const cached = cache.get(moduleRef);
    if (cached) return cached;
    const loaded = loadFromS3(deps, moduleRef);
    cache.set(moduleRef, loaded);
    // download / import が失敗したら cache から外し、 次回 invoke で再試行できるようにする。
    loaded.catch(() => cache.delete(moduleRef));
    return loaded;
  };
}

async function loadFromS3(deps: S3PluginImporterDeps, moduleRef: string): Promise<unknown> {
  const out = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.bucket, Key: coordinationPluginS3Key(moduleRef) }),
  );
  const body = await out.Body?.transformToString();
  if (!body) throw new Error(`coordination plugin not found or empty: ${moduleRef}`);
  // import() する前に整合性を検証する (= 改ざんされた bytes を実行しない fail-closed gate)。
  await verifyDigestIfConfigured(deps, moduleRef, body);
  // /tmp に書き出して file URL で dynamic import (ESM)。 unique dir で他 ref と衝突させない。
  const dir = await mkdtemp(join(tmpdir(), "coord-plugin-"));
  const file = join(dir, `${moduleRef}.mjs`);
  await writeFile(file, body, "utf8");
  return import(pathToFileURL(file).href);
}

/**
 * resolver が設定されていれば、 download した bytes の digest を期待値と照合する。
 * 不一致は throw (= import 前に止める)。 resolver 未設定 / undefined 返却は検証 skip。
 */
async function verifyDigestIfConfigured(
  deps: S3PluginImporterDeps,
  moduleRef: string,
  body: string,
): Promise<void> {
  if (!deps.resolveExpectedDigest) return;
  const expected = await deps.resolveExpectedDigest(moduleRef);
  if (expected === undefined) return;
  const actual = pluginBundleDigest(body);
  if (!digestsEqual(actual, expected)) {
    throw new Error(
      `coordination plugin digest mismatch for ${moduleRef}: expected ${expected}, got ${actual}`,
    );
  }
}
