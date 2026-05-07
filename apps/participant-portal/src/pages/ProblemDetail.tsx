import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Navigate, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { ProblemPanel } from "../components/ProblemPanel";
import type { AppConfig } from "../config";

/**
 * 1 問題の詳細ページ。Quests から click で来る。`useTeamView()` の問題リストから
 * `:problemId` 一致する 1 件を見つけて `ProblemPanel` を 1 つだけ表示する。
 *
 * 不在 (= deploy されていない / 旧 deployment) の場合は Quests へ navigate。
 */
export function ProblemDetailPage({ config }: { config: AppConfig }) {
  const { problemId } = useParams<{ problemId: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error, refresh } = useTeamView();

  if (!problemId) return <Navigate to="/problems" replace />;

  const problem = view?.problems.find((p) => p.problemId === problemId);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={<Button onClick={() => navigate("/problems")}>問題一覧へ戻る</Button>}
      >
        {problemId}
      </Header>

      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}

      {!problem && view && (
        <Alert type="warning" header="この問題は自チームに deploy されていません">
          <Box variant="p">
            <code>{problemId}</code> は自チームの deploy リストに無いため、詳細を表示できません。
            operator にお問い合わせください。
          </Box>
        </Alert>
      )}
      {!problem && !view && !error && <Box>状態を取得中…</Box>}

      {problem && (
        <ProblemPanel
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
        />
      )}
    </SpaceBetween>
  );
}
