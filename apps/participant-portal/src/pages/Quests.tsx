import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Cards from "@cloudscape-design/components/cards";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useNavigate } from "react-router";
import type { DeploymentStatus, ParticipantProblemView } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

const SCORING_KIND_LABEL = {
  flag: "Challenge (flag 提出)",
  uptime: "Battle (uptime 加点)",
} as const;

/**
 * 自チーム向け deploy 済問題のカタログ画面 (sidebar 「問題一覧」)。Home に対する
 * compact な navigation focus 版で、各問題の status / score / アクセス先 URL を
 * カード表示する。
 *
 * データ source は `useTeamView()` (= ShellLayout 内の `/portal/me` polling 結果を共有)。
 * 専用 polling は持たない (Home / TopNav と同じ context を使う)。
 */
export function QuestsPage({ config }: { config: AppConfig }) {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const isBackend = config.mode === "backend";

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="自チームに deploy された問題のカタログ。各カードからアクセス先 URL に直接遷移できます。"
      >
        問題一覧 (Quests)
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

      <Cards<ParticipantProblemView>
        items={view ? [...view.problems] : []}
        loading={isBackend && !view && !error}
        loadingText="問題を取得中…"
        cardDefinition={{
          // jobId (ULID) を URL key にする。problemId (slug) は metadata 上 unique 前提だが、
          // 将来 problemId を意図せず重複登録された場合の link 衝突を回避する防御。
          header: (problem) => (
            <Link
              fontSize="heading-m"
              href={`/problems/${encodeURIComponent(problem.jobId)}`}
              onFollow={(e) => {
                e.preventDefault();
                navigate(`/problems/${encodeURIComponent(problem.jobId)}`);
              }}
            >
              <code>{problem.problemId}</code>
            </Link>
          ),
          sections: [
            {
              id: "status",
              header: "ステータス",
              content: (problem) => (
                <StatusIndicator type={STATUS_TYPE[problem.status]}>
                  {problem.status}
                </StatusIndicator>
              ),
            },
            {
              id: "kind",
              header: "形式",
              content: (problem) =>
                problem.scoring ? SCORING_KIND_LABEL[problem.scoring.kind] : "(未設定)",
            },
            {
              id: "score",
              header: "現在の Score",
              content: (problem) => (
                <Box variant="strong" color="text-status-success">
                  {problem.score} pt
                </Box>
              ),
            },
            {
              id: "region",
              header: "Region",
              content: (problem) => problem.region,
            },
            {
              id: "outputs",
              header: "アクセス先 URL",
              content: (problem) => {
                const entries = Object.entries(problem.stackOutputs);
                if (entries.length === 0) {
                  return (
                    <Box variant="small" color="text-status-inactive">
                      まだ deploy 完了していません
                    </Box>
                  );
                }
                return (
                  <SpaceBetween size="xs">
                    {entries.map(([label, value]) => (
                      <Box key={label}>
                        <Box variant="awsui-key-label">{label}</Box>
                        <a href={value} target="_blank" rel="noreferrer noopener">
                          <code>{value}</code>
                        </a>
                      </Box>
                    ))}
                  </SpaceBetween>
                );
              },
            },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
        empty={
          <Container>
            <Box textAlign="center" padding="l">
              <Box variant="strong">問題がありません</Box>
              <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                このチームには deploy 済みの問題がありません。operator にお問い合わせください。
              </Box>
            </Box>
          </Container>
        }
      />
    </SpaceBetween>
  );
}
