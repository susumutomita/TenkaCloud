import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Grid from "@cloudscape-design/components/grid";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { AppConfig } from "./config";

export function App({ config }: { config: AppConfig }) {
  return (
    <Box padding={{ vertical: "xxl", horizontal: "l" }}>
      <Box margin={{ bottom: "xxl" }}>
        <SpaceBetween size="l">
          <Header
            variant="h1"
            description="AWS マルチテナント SaaS のクラウドコンペティション基盤。 GameDay / JAM 風の Battle と常設 Challenge を、 主催者 1 人で独力で開催できる OSS プラットフォーム。"
          >
            TenkaCloud — Cloud Competition Platform
          </Header>
          <SpaceBetween size="xs" direction="horizontal">
            {config.waitlistFormUrl ? (
              <Button variant="primary" href="#waitlist">
                ウェイトリストに登録
              </Button>
            ) : null}
            <Button
              variant="normal"
              href={config.githubRepoUrl}
              iconAlign="right"
              iconName="external"
            >
              GitHub で見る
            </Button>
            {config.participantPortalUrl ? (
              <Button
                variant="link"
                href={config.participantPortalUrl}
                iconAlign="right"
                iconName="external"
              >
                Participant Portal
              </Button>
            ) : null}
            {config.adminConsoleUrl ? (
              <Button
                variant="link"
                href={config.adminConsoleUrl}
                iconAlign="right"
                iconName="external"
              >
                System Admin Console
              </Button>
            ) : null}
          </SpaceBetween>
        </SpaceBetween>
      </Box>

      <Box margin={{ bottom: "xxl" }}>
        <Container
          header={
            <Header
              variant="h2"
              description="主催者が抱える「インフラを書く」「採点を書く」「競技者環境を配る」の 3 重苦を、 platform 側に閉じ込めた"
            >
              なぜ TenkaCloud か
            </Header>
          }
        >
          <ColumnLayout columns={3} variant="text-grid">
            <FeatureCard
              title="問題は plugin、 platform は host"
              body="問題 = metadata.json + CFn ペライチ + 任意の portal/dashboard。 採点関数は 5 種類の builtin kind から 1 つ宣言するだけ。 platform に問題固有のコードを書く必要は無い"
            />
            <FeatureCard
              title="競技者環境を 1 click で配布"
              body="主催者は問題を deploy するだけ。 競技者は IAM Role を assume してそのまま AWS Console を開ける。 EventBridge → Worker Lambda → CFn CreateStack まで自動"
            />
            <FeatureCard
              title="コスト爆発を未然に防ぐ"
              body="DynamoDB は 1 RCU / 1 WCU PROVISIONED 強制 (Free Tier 内)。 AWS Budgets で月次コストを 80% / 100% で email alarm。 Lambda 暴走を early signal で検知"
            />
            <FeatureCard
              title="マルチテナント (= SaaS) と single-tenant"
              body="SBT 0.3.9 (Software-as-a-Service Builder Toolkit) ベース。 BASIC / STANDARD / PREMIUM は pooled、 PLATINUM は silo stack。 個人開催なら single-tenant モードで起動"
            />
            <FeatureCard
              title="認証はインフラ層で注入"
              body="Cognito UserPool + Hosted UI + OAuth Code + PKCE。 アプリ側に AUTH_SKIP 的な bypass を書かない。 MFA TOTP は tenant UserPool で REQUIRED"
            />
            <FeatureCard
              title="ADR で意思決定を正本化"
              body="docs/architecture/adr-*.html に背景・判断・影響・代替案・移行方針を self-contained に。 architecture invariant は `make harness` で機械検査"
            />
          </ColumnLayout>
        </Container>
      </Box>

      <Box margin={{ bottom: "xxl" }}>
        <Container
          header={
            <Header
              variant="h2"
              description="主催者 (= 大会オペレーター) と競技者 (= participant) の 2 つの persona で完結する"
            >
              使い方
            </Header>
          }
        >
          <ColumnLayout columns={2}>
            <Box>
              <Header variant="h3">主催者として開催する</Header>
              <Box variant="p">
                <ol>
                  <li>
                    repo を clone して <code>make deploy ENV=production</code>
                  </li>
                  <li>System Admin Console から tenant (= 大会) を作成</li>
                  <li>
                    <code>/create-problem</code> で問題雛形を生成し、 metadata.json と template.yaml
                    を編集
                  </li>
                  <li>競技者 (= team) を招待 (= login key を配布)</li>
                </ol>
              </Box>
            </Box>
            <Box>
              <Header variant="h3">競技者として参加する</Header>
              <Box variant="p">
                <ol>
                  <li>主催者から渡された login key で Participant Portal にログイン</li>
                  <li>
                    問題一覧から「これに挑戦」をクリック → 自分の AWS account に環境が deploy される
                  </li>
                  <li>AWS Console に federated user として直接サインインして調査・修復</li>
                  <li>flag を提出 → scoring engine が builtin kind で自動採点</li>
                </ol>
              </Box>
            </Box>
          </ColumnLayout>
        </Container>
      </Box>

      <Box id="waitlist" margin={{ bottom: "xxl" }}>
        <Container
          header={
            <Header
              variant="h2"
              description="ベータ版の招待をご希望の方は、 Google Form にご記入ください (= 開催ご相談の方も歓迎)"
            >
              ウェイトリスト
            </Header>
          }
        >
          <WaitlistEmbed formUrl={config.waitlistFormUrl} />
        </Container>
      </Box>

      <Box>
        <Grid gridDefinition={[{ colspan: 12 }]}>
          <Box variant="small" textAlign="center" color="text-body-secondary">
            <SpaceBetween size="xs" direction="horizontal">
              <Link href={config.githubRepoUrl} external>
                GitHub
              </Link>
              <span>·</span>
              <Link href={`${config.githubRepoUrl}/blob/main/LICENSE`} external>
                MIT License
              </Link>
              <span>·</span>
              <Link href={`${config.githubRepoUrl}/issues`} external>
                Issues
              </Link>
            </SpaceBetween>
          </Box>
        </Grid>
      </Box>
    </Box>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <Box>
      <Header variant="h3">{title}</Header>
      <Box variant="p">{body}</Box>
    </Box>
  );
}

function WaitlistEmbed({ formUrl }: { formUrl: string | null }) {
  if (!formUrl) {
    return (
      <Alert type="info" header="Google Form 未設定" statusIconAriaLabel="info">
        <Box variant="p">
          ウェイトリスト用の Google Form がまだ設定されていません。 主催者は{" "}
          <code>VITE_WAITLIST_FORM_URL</code> 環境変数 (dev) または <code>runtime-config.json</code>{" "}
          の <code>waitlistFormUrl</code> (production) に embed URL を設定してください。
        </Box>
      </Alert>
    );
  }
  return (
    <iframe
      src={formUrl}
      title="TenkaCloud waitlist (Google Forms)"
      width="100%"
      height="800"
      style={{ border: 0, maxWidth: "720px", display: "block", margin: "0 auto" }}
    >
      Loading...
    </iframe>
  );
}
