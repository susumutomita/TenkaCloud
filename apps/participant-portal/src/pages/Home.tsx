import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ParticipantTeamView } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { ProblemPanel } from "../components/ProblemPanel";
import type { AppConfig } from "../config";

export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";
  // Polling は ShellLayout の TeamViewProvider で一括管理される (TopNav も同じデータを共有)。
  const { view, error, refresh } = useTeamView();

  const teamName = view?.team.teamName ?? auth.session?.teamName ?? "(unknown)";

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`${config.eventTitle} へようこそ`}>
        Welcome, {teamName}
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}
      {isBackend && !view && !error && <Box>状態を取得中…</Box>}

      {view && <TeamScorePanel view={view} />}

      {view?.problems.map((problem) => (
        <ProblemPanel
          key={problem.jobId}
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
        />
      ))}

      {view && view.problems.length === 0 && (
        <Container header={<Header variant="h2">問題がありません</Header>}>
          <Box>このチームには deploy 済みの問題がありません。operator にお問い合わせください。</Box>
        </Container>
      )}
    </SpaceBetween>
  );
}

function TeamScorePanel({ view }: { view: ParticipantTeamView }) {
  const totalScore = view.problems.reduce((sum, p) => sum + p.score, 0);
  return (
    <Container header={<Header variant="h2">チーム累計スコア</Header>}>
      <KeyValuePairs
        columns={3}
        items={[
          {
            label: "合計",
            value: (
              <Box variant="awsui-value-large" color="text-status-success">
                {totalScore} pt
              </Box>
            ),
          },
          { label: "問題数", value: String(view.problems.length) },
          {
            label: "完了済",
            value: String(view.problems.filter((p) => p.status === "COMPLETE").length),
          },
        ]}
      />
    </Container>
  );
}
