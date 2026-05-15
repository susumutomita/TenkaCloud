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
import { useT } from "../i18n";

export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";
  const t = useT();
  // Polling は ShellLayout の TeamViewProvider で一括管理される (TopNav も同じデータを共有)。
  const { view, error, refresh } = useTeamView();

  const teamName = view?.team.teamName ?? auth.session?.teamName ?? "(unknown)";

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("home.welcome_description", { eventTitle: config.eventTitle })}
      >
        {t("home.welcome", { teamName })}
      </Header>

      {!isBackend && <Alert type="info">{t("app.dev_mock_alert")}</Alert>}
      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {isBackend && !view && !error && <Box>{t("app.loading")}</Box>}

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
        <Container header={<Header variant="h2">{t("home.no_problems_header")}</Header>}>
          <Box>{t("home.no_problems_body")}</Box>
        </Container>
      )}
    </SpaceBetween>
  );
}

function TeamScorePanel({ view }: { view: ParticipantTeamView }) {
  const t = useT();
  const totalScore = view.problems.reduce((sum, p) => sum + p.score, 0);
  return (
    <Container header={<Header variant="h2">{t("home.team_score_header")}</Header>}>
      <KeyValuePairs
        columns={3}
        items={[
          {
            label: t("home.score_total"),
            value: (
              <Box variant="awsui-value-large" color="text-status-success">
                {totalScore} pt
              </Box>
            ),
          },
          { label: t("home.score_problem_count"), value: String(view.problems.length) },
          {
            // Issue #821 / #822: 旧 \"deploy COMPLETE\" カウントから 「正解した問題数」 に
            // 変更する。 flag 問題は flagSubmitted=true、 非 flag (Battle) は score>0 を
            // 「解いた」 と扱う (= スコアを稼げてれば貢献あり)。
            label: t("home.score_completed_count"),
            value: String(
              view.problems.filter((p) => {
                if (p.scoring?.kind === "flag") return p.scoring.flagSubmitted === true;
                return p.score > 0;
              }).length,
            ),
          },
        ]}
      />
    </Container>
  );
}
