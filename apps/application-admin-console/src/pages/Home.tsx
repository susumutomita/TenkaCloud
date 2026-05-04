import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import type { AppConfig } from "../config";

/**
 * 認証済みテナント開発者が最初に見るページ。
 *
 * Header に tenantName を出し、「アプリを公開する」 CTA を置くだけのシンプル画面。
 * ユーザーの email / JWT tenantId などシステム内部情報は HomePage に出さない
 * (必要なら将来 Profile ページ等で別途扱う)。
 */
export function HomePage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`${config.tenantName} のテナント開発者向けコンソール`}
        actions={
          <Button variant="primary" onClick={() => navigate("/apps/new")}>
            アプリを公開する
          </Button>
        }
      >
        Application Admin Console
      </Header>
      <Container header={<Header variant="h2">Hello, {config.tenantName}.</Header>}>
        <p>
          バイブコーディングしたアプリを「公開する」と、認証付きの Function URL
          が即座に払い出されます。
          左の「公開アプリ」から既存の登録を確認したり、「アプリを公開する」から新規登録できます。
        </p>
      </Container>
    </SpaceBetween>
  );
}
