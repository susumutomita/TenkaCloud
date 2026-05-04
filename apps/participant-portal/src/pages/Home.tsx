import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * 認証済みの参加者が最初に見るページ。AWS GameDay 参考画面の Home に対応。
 */
export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const teamName = auth.session?.teamName ?? "(unknown)";

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`${config.eventTitle} へようこそ`}>
        Welcome, {teamName}
      </Header>

      <Container header={<Header variant="h2">Event Information</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <Stat label="Status">
            <Badge color="green">In Progress</Badge>
          </Stat>
          <Stat label="Event region">{config.eventRegion}</Stat>
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">これからやること</Header>}>
        <Box variant="p">
          左メニューの <strong>Quests</strong> から、自チームに deploy された問題に
          アクセスできます。スコア状況は <strong>Scoreboard</strong>、得点履歴は{" "}
          <strong>Score events</strong>
          で確認します。運営からの連絡は <strong>Notifications</strong> に届きます。 AWS Console
          へのサインイン情報は <strong>Tools → SSO Credentials</strong> から取得します。
        </Box>
      </Container>
    </SpaceBetween>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
