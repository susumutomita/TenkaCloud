import { Navigate, useSearchParams } from "react-router";
import type { AppConfig } from "../config";
import { HomePage } from "./Home";

/**
 * #2711 フォローアップ: LP hero カードは `/portal-demo/?demo=1&goto=start` で着地する。
 * `/portal-demo/start` の deep link は静的ホスティング側の rewrite (`landing/_redirects`)
 * が無いと 404 → 別ページへの fallback で崩れるため、 入口は必ず実在する
 * `/portal-demo/index.html` を踏み、 遷移は client 側で行う (= rewrite 非依存)。
 * `goto=start` が付いていたら `/start` へ replace し、 それ以外は従来どおり Home。
 */
export function RootEntryPage({ config }: { config: AppConfig }) {
  const [params] = useSearchParams();
  if (params.get("goto") === "start") {
    return <Navigate to="/start" replace />;
  }
  return <HomePage config={config} />;
}
