import { Navigate, useSearchParams } from "react-router";
import type { AppConfig } from "../config";
import { HomePage } from "./Home";

/**
 * `goto` クエリを router 内部 path へ解決する。 対象は 2 系統:
 *
 * - `goto=start` — LP hero カードの `/portal-demo/?demo=1&goto=start` 導線 (#2711)。
 * - `goto=/problems/xxx` などの内部 path — deep link のリロード復元。 Cloudflare Pages の
 *   暗黙 SPA fallback (404.html 不在時) は `landing/_redirects` の 200 rewrite より優先され、
 *   デモ deep link のリロードに landing の index.html を返すため、 landing 側の復旧
 *   スクリプトが `/portal-demo/?goto=<元パス>` へ replace してくる。 その復元先をここで受ける。
 *
 * open redirect / traversal を防ぐため、 先頭 `/` の相対 path のみ許可し、
 * `//` (protocol-relative)・`..`・`:` (スキーム) を含む値は拒否して null を返す。
 */
export function resolveGotoTarget(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === "start") return "/start";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("..") || raw.includes(":")) {
    return null;
  }
  return raw;
}

/**
 * #2711 フォローアップ: 入口は必ず実在する `/portal-demo/index.html` を踏み、 遷移は
 * client 側で行う (= rewrite 非依存)。 `goto` が解決できたらそこへ replace し、
 * それ以外は従来どおり Home。
 */
export function RootEntryPage({ config }: { config: AppConfig }) {
  const [params] = useSearchParams();
  const target = resolveGotoTarget(params.get("goto"));
  if (target) {
    return <Navigate to={target} replace />;
  }
  return <HomePage config={config} />;
}
