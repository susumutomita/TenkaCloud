import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { DeployFormModal } from "../components/DeployForm";
import type { AppConfig } from "../config";
import { findProblem } from "../data/problems";

const DIFFICULTY_LABEL = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
} as const;

/**
 * 問題詳細ページ。manifest 由来のメタデータを表示し「競技アカウントへデプロイ」CTA を出す。
 * Deploy ボタンは Modal を開き、HTTP API 経由で deploy job を起動する。
 */
export function ProblemDetailPage({ config }: { config: AppConfig }) {
  const { problemId } = useParams<{ problemId: string }>();
  const navigate = useNavigate();
  const [confirmingDeploy, setConfirmingDeploy] = useState(false);

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
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => navigate("/problems")}>一覧へ戻る</Button>
            <Button
              variant="primary"
              disabled={problem.status !== "ready" && problem.status !== "draft"}
              onClick={() => setConfirmingDeploy(true)}
            >
              競技アカウントへデプロイ
            </Button>
          </SpaceBetween>
        }
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

      <DeployFormModal
        config={config}
        problemId={problem.id}
        problemName={problem.name}
        visible={confirmingDeploy}
        onDismiss={() => setConfirmingDeploy(false)}
      />
    </SpaceBetween>
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
