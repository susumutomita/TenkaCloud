import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * landing の HTML が参照する `./styles/main.css?v=…` / `./app.js?v=…` の
 * キャッシュバスターを、参照先ファイルの内容ハッシュへ書き換える。
 *
 * 背景: 以前は日付の手動バスター (`?v=20260625-2`) で、CSS を変えても bump を
 * 忘れると CDN/ブラウザが古いアセットを返し続け、「HTML は新しいのに新クラスの
 * スタイルが無い」壊れ方をする (#2711 の hero カードで実際に発生)。内容ハッシュ
 * なら変更すれば必ず URL が変わり、変わらなければ同じ URL でキャッシュが効く。
 *
 * 実行タイミング: `bun run generate:landing-locales` 系と同じく手元で実行して
 * commit する (landing-seo.test.ts がハッシュ一致を機械検証する)。さらに
 * `build:pages` (Cloudflare Pages のビルド) でも最後に走るので、deploy 時にも
 * 必ず正しいハッシュが刻まれる。
 */

const root = join(import.meta.dir, "../..");
const landing = join(root, "landing");

export function assetVersion(content: string | Buffer): string {
  // Cache-buster fingerprint, not a security control: the digest only has to change when
  // the asset's bytes change, and it ends up in a `?v=` query string. Collision
  // resistance buys nothing here.
  // eslint-disable-next-line sonarjs/hashing -- non-cryptographic content fingerprint
  return createHash("sha1").update(content).digest("hex").slice(0, 10);
}

/**
 * ハッシュを刻む対象。 HTML から `./<path>?v=…` で参照されるものを列挙する。
 * 新しいアセットを HTML に足したらここにも足す (= 足し忘れるとキャッシュ
 * バスターが効かず、 古い JS/CSS が配信され続ける)。
 */
export const STAMPED_ASSETS = ["styles/main.css", "app.js"] as const;

export type AssetVersions = Record<string, string>;

export function stampHtml(html: string, versions: AssetVersions): string {
  return Object.entries(versions).reduce((stamped, [asset, version]) => {
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return stamped.replaceAll(new RegExp(`(\\./${escaped})\\?v=[^"]*`, "g"), `$1?v=${version}`);
  }, html);
}

export function currentVersions(): AssetVersions {
  return Object.fromEntries(
    STAMPED_ASSETS.map((asset) => [asset, assetVersion(readFileSync(join(landing, asset)))]),
  );
}

const GAME_REFERENCE = /(["'])(\.\/[^"'?\s]+\.(?:js|css))(?:\?v=[a-f0-9]{10})?\1/g;

export function cloudMasterVersion(files: Record<string, string>): string {
  return assetVersion(
    Object.keys(files)
      .sort((a, b) => a.localeCompare(b, "en"))
      .map(
        (name) =>
          `${name}\0${files[name].replace(/(\.\/[^"'?\s]+\.(?:js|css))\?v=[a-f0-9]{10}/g, "$1")}`,
      )
      .join("\0"),
  );
}

export function stampCloudMasterFile(
  source: string,
  name: string,
  files: Record<string, string>,
  version: string,
): string {
  return source.replace(GAME_REFERENCE, (match, quote: string, path: string) => {
    const target = posix.join(posix.dirname(name), path);
    return Object.hasOwn(files, target) ? `${quote}${path}?v=${version}${quote}` : match;
  });
}

export function cloudMasterFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(relative = "") {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (/\.(?:js|css)$/.test(name))
        files[name] = readFileSync(join(directory, name), "utf8");
    }
  }
  visit();
  return files;
}

function stampCloudMaster(directory: string) {
  const files = cloudMasterFiles(directory);
  const version = cloudMasterVersion(files);
  const targets = { ...files, "index.html": readFileSync(join(directory, "index.html"), "utf8") };
  for (const [name, before] of Object.entries(targets)) {
    const after = stampCloudMasterFile(before, name, files, version);
    if (after !== before) writeFileSync(join(directory, name), after);
  }
}

function main() {
  // Version the entire module graph, not just its entry: cached dependencies can otherwise
  // mix incompatible releases. Normalize generated versions before hashing to stay idempotent.
  stampCloudMaster(join(landing, "cloud-master"));
  stampCloudMaster(join(landing, "mail-detective"));
  stampCloudMaster(join(landing, "work-dm"));
  const versions = currentVersions();
  const targets = readdirSync(landing).filter((name) => name.endsWith(".html"));
  for (const name of targets) {
    const path = join(landing, name);
    const before = readFileSync(path, "utf8");
    const after = stampHtml(before, versions);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`stamped ${name} (${JSON.stringify(versions)})`);
    }
  }
}

if (import.meta.main) main();
