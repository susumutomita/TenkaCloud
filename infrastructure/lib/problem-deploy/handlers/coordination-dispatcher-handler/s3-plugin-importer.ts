import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PluginImporter } from "../participant-handler/coordination-plugin-loader.js";

/**
 * ADR-030 Phase 3b (#1420): coordination plugin の実 importer。
 *
 * 同 ADR が「動的 load の対象 = レビュー済みカタログ bundle (= S3)」(S1) と定めた通り、 問題が同梱した
 * coordination plugin を **synth 時に esbuild で self-contained .mjs に bundle → S3 へ upload** したものを、
 * dispatcher Lambda が runtime に download → `import()` する。 plugin が AWS SDK / fetch / 環境変数に
 * 触れても本 Lambda は最小 IAM (ADR-030 S2、 PR #1633) で competitor 資格情報・他テナントデータに
 * 構造的に到達できないため、 in-process 実行の blast radius は coordination state 行に限定される。
 *
 * `moduleRef` は problem id (= scope resolver が解決した一意キー)。 S3 key は `coordination/<id>.mjs`。
 * 同 Lambda 実行内では module-level cache で再 download / 再 import を避ける (= plugin は event 中 immutable)。
 */
export interface S3PluginImporterDeps {
  readonly s3: Pick<S3Client, "send">;
  readonly bucket: string;
}

export function coordinationPluginS3Key(moduleRef: string): string {
  return `coordination/${moduleRef}.mjs`;
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
  // /tmp に書き出して file URL で dynamic import (ESM)。 unique dir で他 ref と衝突させない。
  const dir = await mkdtemp(join(tmpdir(), "coord-plugin-"));
  const file = join(dir, `${moduleRef}.mjs`);
  await writeFile(file, body, "utf8");
  return import(pathToFileURL(file).href);
}
