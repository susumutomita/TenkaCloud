import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";
import { listProblemSummaries } from "../data/problems";

/**
 * TenantAdmin のホーム画面。
 *
 *  - hero: ようこそ + テナント識別
 *  - クイックアクション: 「問題をデプロイする」「テナント設定」(後者は stub)
 *  - 問題カタログのプレビュー (件数 + ready 件数)
 *  - テナント情報 (JWT claims)
 *
 * テナント名は JWT (custom:tenantName / custom:tenantId) から取り出す。
 * config.tenantName は pooled stack で "Shared Pooled Tenant" placeholder のため使わない。
 */
export function HomePage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const claims = auth.tokens ? decodeIdToken(auth.tokens.idToken) : null;
  const tenantName = claims?.["custom:tenantName"];
  const tenantId = claims?.["custom:tenantId"];
  const tenantTier = claims?.["custom:tenantTier"];
  const userEmail = claims?.email;
  const displayName = tenantName ?? tenantId ?? "(unknown tenant)";

  const problems = listProblemSummaries();
  const totalCount = problems.length;
  const readyCount = problems.filter((p) => p.status === "ready").length;
  const draftCount = problems.filter((p) => p.status === "draft").length;
  const battleCount = problems.filter((p) => p.category === "Battle").length;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="TenkaCloud Battle / Challenge — テナント管理コンソール"
        actions={
          <Button variant="primary" onClick={() => navigate("/problems")}>
            問題カタログを開く
          </Button>
        }
      >
        ようこそ、{displayName} さん
      </Header>

      <Container header={<Header variant="h2">問題カタログ</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Stat label="登録数" value={String(totalCount)} />
          <Stat label="公開中 (ready)" value={String(readyCount)} />
          <Stat label="下書き (draft)" value={String(draftCount)} />
          <Stat label="Battle" value={String(battleCount)} />
        </ColumnLayout>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            actions={<Button onClick={() => navigate("/problems")}>すべての問題を見る</Button>}
          >
            次のアクション
          </Header>
        }
      >
        <Box variant="p">
          競技アカウントへ問題をデプロイすると、参加者向けの URL (frontend / api) と、
          <strong>チーム単位のログインキー</strong>{" "}
          が払い出されます。参加者個別のアカウントは作成せず、各チームに 1
          つ配布する短命なキーでアクセス制御するため、運営側で個人情報の管理義務を抱え込みません。
          まずは <strong>問題カタログ</strong> から問題を 1 つ選んでください。
        </Box>
      </Container>

      <Container header={<Header variant="h2">テナント情報</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValue label="テナント名" value={tenantName ?? "(未設定)"} />
          <KeyValue label="テナント ID" value={tenantId ?? "(unknown)"} />
          <KeyValue
            label="プラン"
            valueNode={tenantTier ? <Badge>{tenantTier}</Badge> : <span>(unknown)</span>}
          />
          <KeyValue label="サインインユーザー" value={userEmail ?? "(unknown)"} />
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box fontSize="display-l" fontWeight="bold">
        {value}
      </Box>
    </div>
  );
}

function KeyValue({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      {valueNode ?? <Box variant="p">{value ?? ""}</Box>}
    </div>
  );
}
