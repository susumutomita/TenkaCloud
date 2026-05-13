import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";
import { listProblemSummaries } from "../data/problems";
import { useT } from "../i18n";

// #542: 初回 operator 向けの onboarding section を dismiss 可能にするための localStorage key。
// 2 回目以降の visit では「次のアクション」 section を出さず、画面上半分を進行中 Event 一覧
// 等の優先情報に譲る。値は "true" のみ意味を持つ。
const ONBOARDING_DISMISSED_KEY = "TenkaCloud.applicationAdmin.onboardingDismissed";

function readOnboardingDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOnboardingDismissed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    else window.localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
  } catch {
    // localStorage 不可 (= private mode 等) は no-op、毎回表示で安全側
  }
}

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
  const t = useT();
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

  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("home.header_description")}
        actions={
          <Button variant="primary" onClick={() => navigate("/problems")}>
            {t("home.open_catalog")}
          </Button>
        }
      >
        {t("home.welcome", { displayName })}
      </Header>

      <Container header={<Header variant="h2">問題カタログ</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Stat label="登録数" value={String(totalCount)} />
          <Stat label="公開中 (ready)" value={String(readyCount)} />
          <Stat label="下書き (draft)" value={String(draftCount)} />
          <Stat label="Battle" value={String(battleCount)} />
        </ColumnLayout>
      </Container>

      {/* #542: 初回 onboarding section。閉じると localStorage に dismissed=true が記録され
       *   以降の visit で出ない。テナント情報の上に置いて初見 operator の導線にする。*/}
      {!onboardingDismissed && (
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={() => navigate("/problems")}>すべての問題を見る</Button>
                  <Button
                    iconName="close"
                    variant="icon"
                    ariaLabel="次のアクション section を閉じる"
                    onClick={() => {
                      writeOnboardingDismissed(true);
                      setOnboardingDismissed(true);
                    }}
                  />
                </SpaceBetween>
              }
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
      )}

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
