import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";

/**
 * 認証済み TenantAdmin が最初に見るページ。
 *
 * JWT (id_token) から `custom:tenantName` (将来) と `custom:tenantId` (現状) を読んで
 * 「どのテナントとしてログインしているか」を明示する。pooled stack 経由でも
 * 自分のテナント名が出る (config.tenantName の "Shared Pooled Tenant" placeholder ではない)。
 *
 * 機能ボタン (問題管理 / イベント管理 / 参加者管理) は今後の PR で追加する。
 */
export function HomePage() {
  const auth = useAuth();
  const claims = auth.tokens ? decodeIdToken(auth.tokens.idToken) : null;
  const tenantName = claims?.["custom:tenantName"];
  const tenantId = claims?.["custom:tenantId"];
  const tenantTier = claims?.["custom:tenantTier"];
  const userEmail = claims?.email;
  const displayName = tenantName ?? tenantId ?? "(unknown tenant)";

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="TenkaCloud Battle / Challenge — テナント管理コンソール">
        ようこそ、{displayName} さん
      </Header>

      <Container header={<Header variant="h2">テナント情報</Header>}>
        <SpaceBetween size="s">
          <KeyValue label="テナント名" value={tenantName ?? "(未設定)"} />
          <KeyValue label="テナント ID" value={tenantId ?? "(unknown)"} />
          <KeyValue label="プラン" value={tenantTier ?? "(unknown)"} />
          <KeyValue label="サインインユーザー" value={userEmail ?? "(unknown)"} />
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">次のステップ</Header>}>
        <Box variant="p">
          このコンソールから問題を競技アカウントへデプロイし、参加者にプレイ環境を配布します。
          管理機能 (問題一覧 / デプロイ / 参加者管理) は順次追加予定です。
        </Box>
      </Container>
    </SpaceBetween>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="p">{value}</Box>
    </div>
  );
}
