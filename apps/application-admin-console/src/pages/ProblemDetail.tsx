import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, type NavigateFunction, useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import {
  DEPLOYMENT_STATUS_INDICATOR,
  type DeploymentSummary,
  listDeployments,
} from "../api/deploy-client";
import type { AppConfig } from "../config";
import { findProblem } from "../data/problems";
import {
  DEPLOYMENT_LIST_PAGE_SIZE,
  DEPLOYMENT_LIST_POLL_INTERVAL_MS,
  deploymentsChanged,
  EMPTY_DEPLOYMENT_ITEMS,
} from "../utils/deployments";

const DIFFICULTY_LABEL = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
} as const;

/**
 * 問題詳細ページ。manifest 由来のメタデータを read-only で表示する。
 *
 * 旧: 「競技アカウントへデプロイ」CTA で単発 deploy できたが、Event 紐付き無しの
 * orphan deployment になり scoreboard / 集計に出ない問題があったため flow を廃止。
 * 全 deploy は Event の Bulk Deploy 経由のみ。
 */
export function ProblemDetailPage({ config }: { config: AppConfig }) {
  const { problemId } = useParams<{ problemId: string }>();
  const navigate = useNavigate();

  if (!problemId) return <Navigate to="/problems" replace />;
  const problem = findProblem(problemId);
  if (!problem) {
    return (
      <SpaceBetween size="l">
        <Header variant="h1">問題が見つかりません</Header>
        <Alert type="error">指定された問題 ID ({problemId}) はカタログに存在しません。</Alert>
        <Button onClick={() => navigate("/problems")}>問題一覧へ戻る</Button>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={problem.shortDescription}
        actions={<Button onClick={() => navigate("/problems")}>一覧へ戻る</Button>}
      >
        {problem.name}
      </Header>

      <Container header={<Header variant="h2">概要</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Meta label="カテゴリ">
            <Badge color={problem.category === "Battle" ? "red" : "blue"}>{problem.category}</Badge>
          </Meta>
          <Meta label="難易度">{DIFFICULTY_LABEL[problem.difficulty]}</Meta>
          <Meta label="想定プレイ時間">{problem.estimatedDuration}</Meta>
          <Meta label="ステータス">
            <Badge color={problem.status === "ready" ? "green" : "blue"}>{problem.status}</Badge>
          </Meta>
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">問題説明</Header>}>
        <Box variant="p">
          <span style={{ whiteSpace: "pre-wrap" }}>{problem.description}</span>
        </Box>
      </Container>

      <Container header={<Header variant="h2">学習目的</Header>}>
        <ul>
          {problem.learningGoals.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </Container>

      <Container header={<Header variant="h2">参加者に払い出されるエンドポイント</Header>}>
        <SpaceBetween size="s">
          <Box variant="p">
            デプロイ完了時、競技アカウント上で立ち上がった以下のポートが、参加者に共有可能な URL
            として表示されます。
          </Box>
          <ul>
            {problem.exposedPorts.map((p) => (
              <li key={`${p.name}-${p.port}`}>
                {p.name} (port {p.port})
              </li>
            ))}
          </ul>
          <Alert type="info" header="アクセス制御は per-team ログインキー">
            各エンドポイントは <strong>チーム単位で発行されるログインキー</strong> で gating
            されます。参加者ごとのユーザーアカウントは作成されないため、運営側で個別アカウントの管理義務
            (招待 / リセット / 削除) を負わない構成です。
          </Alert>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">タグ</Header>}>
        <SpaceBetween direction="horizontal" size="xs">
          {problem.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </SpaceBetween>
      </Container>

      <ProblemDeploymentsSection config={config} problemId={problem.id} />
    </SpaceBetween>
  );
}

function buildColumns(
  navigate: NavigateFunction,
): TableProps.ColumnDefinition<DeploymentSummary>[] {
  // #541: 単発「削除」 button は撤去。削除は EventDetail の「Delete」 (= 旧 Bulk Teardown)
  // に集約。orphan single delete を残すと「片付け済の hidden 行が見えないまま課金される」
  // 危険性があり、operator 視点で削除フローが 1 箇所に集まっている方が事故が少ない。
  return [
    {
      id: "team",
      header: "チーム",
      cell: (item) => (
        <Link
          fontSize="body-m"
          href={`/deployments/${encodeURIComponent(item.jobId)}`}
          onFollow={(e) => {
            e.preventDefault();
            navigate(`/deployments/${encodeURIComponent(item.jobId)}`);
          }}
        >
          {item.displayTeamName ?? item.teamName}
        </Link>
      ),
    },
    {
      id: "status",
      header: "ステータス",
      cell: (item) => (
        <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
          {item.status}
        </StatusIndicator>
      ),
    },
    {
      id: "namePrefix",
      header: "Stack 名",
      cell: (item) => <code>{item.namePrefix}</code>,
    },
    {
      id: "createdAt",
      header: "作成",
      cell: (item) => item.createdAt,
    },
  ];
}

/**
 * ProblemDetail に埋め込むこの問題の deploy 一覧。tenant scope の `listDeployments(problemId)`
 * を 10 秒 polling し、status / 削除操作を operator が直接管理できるようにする。
 */
function ProblemDeploymentsSection({
  config,
  problemId,
}: {
  config: AppConfig;
  problemId: string;
}) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly DeploymentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listDeployments(apiClient, problemId, {
        limit: DEPLOYMENT_LIST_PAGE_SIZE,
      });
      setItems((prev) => (prev && !deploymentsChanged(prev, res.items) ? prev : res.items));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiClient, problemId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchOnce();
    };
    void tick();
    const interval = setInterval(tick, DEPLOYMENT_LIST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce]);

  const columns = useMemo(() => buildColumns(navigate), [navigate]);

  return (
    <Container
      header={
        <Header variant="h2" description={`この問題の進行中 / 過去のデプロイジョブ一覧。`}>
          デプロイ状況
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" header="一覧の取得に失敗しました">
            {error}
          </Alert>
        )}
        <Table
          items={items ?? EMPTY_DEPLOYMENT_ITEMS}
          columnDefinitions={columns}
          loading={items === null && !error}
          loadingText="読み込み中"
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              この問題のデプロイ履歴はまだありません。
            </Box>
          }
        />
      </SpaceBetween>
    </Container>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
