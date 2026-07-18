import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  return createHash("sha1").update(content).digest("hex").slice(0, 10);
}

export function stampHtml(html: string, cssVersion: string, jsVersion: string): string {
  return html
    .replaceAll(/(\.\/styles\/main\.css)\?v=[^"]*/g, `$1?v=${cssVersion}`)
    .replaceAll(/(\.\/app\.js)\?v=[^"]*/g, `$1?v=${jsVersion}`);
}

function main() {
  const cssVersion = assetVersion(readFileSync(join(landing, "styles/main.css")));
  const jsVersion = assetVersion(readFileSync(join(landing, "app.js")));
  const targets = readdirSync(landing).filter((name) => name.endsWith(".html"));
  for (const name of targets) {
    const path = join(landing, name);
    const before = readFileSync(path, "utf8");
    const after = stampHtml(before, cssVersion, jsVersion);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`stamped ${name} (css=${cssVersion}, js=${jsVersion})`);
    }
  }
}

if (import.meta.main) main();
