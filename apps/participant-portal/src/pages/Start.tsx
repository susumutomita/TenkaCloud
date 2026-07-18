import Box from "@cloudscape-design/components/box";
import { Navigate } from "react-router";
import { useTeamView } from "../auth/TeamViewProvider";
import { useT } from "../i18n";

/**
 * #2707 P0-5: LP hero 「始める」の着地点 (`/start`)。 表示順 (= オンボーディング 3 部作が
 * 先頭) で最初の未得点問題へ replace 遷移する evergreen entry。 fixture の jobId (ULID) を
 * landing 側の HTML に埋め込まずに済ませるための indirection でもある。
 * 全問クリア済みなら先頭問題へ、 問題が無い / 取得に失敗したときは問題一覧へ
 * (エラー表示は一覧側の責務)。
 */
export function StartPage() {
  const { view, error } = useTeamView();
  const t = useT();
  if (error) return <Navigate to="/problems" replace />;
  if (!view) return <Box>{t("app.loading")}</Box>;
  const target = view.problems.find((p) => p.score === 0) ?? view.problems[0];
  if (!target) return <Navigate to="/problems" replace />;
  return <Navigate to={`/problems/${encodeURIComponent(target.jobId)}`} replace />;
}
