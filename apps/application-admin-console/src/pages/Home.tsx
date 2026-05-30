import Alert from "@cloudscape-design/components/alert";
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
import { resolveTenantDisplayName } from "../lib/tenant-display";

// #542: 初回 operator 向けの onboarding section を dismiss 可能にするための localStorage key。
// 2 回目以降の visit では「次のアクション」 section を出さず、画面上半分を進行中 Event 一覧
// 等の優先情報に譲る。値は "true" のみ意味を持つ。
const ONBOARDING_DISMISSED_KEY = "TenkaCloud.applicationAdmin.onboardingDismissed";

function readOnboardingDismissed(): boolean {
  // SPA (SSR なし) なので window は常に定義済 = この SSR guard は不到達 (防御)。
  /* v8 ignore next */
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOnboardingDismissed(value: boolean): void {
  // SPA (SSR なし) なので window は常に定義済 = この SSR guard は不到達 (防御)。
  /* v8 ignore next */
  if (typeof window === "undefined") return;
  try {
    // Home からは dismiss (value=true) のみ呼ぶので else (removeItem) は現状不到達 (対称性のため残す防御)。
    /* v8 ignore next 4 */
    if (value) {
      window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    } else {
      window.localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    }
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
  // Issue #831: userEmail は TopNav 右上に移動済。 Home page で参照しない。
  // Issue #830: welcome 文に UUID を出さない。 tenantName が無いときは fallback (= "テナント")
  // を使い、 raw tenantId は 「テナント情報」 panel 側でのみ表示する。
  const { displayName: resolvedName, fromFallback: tenantNameMissing } =
    resolveTenantDisplayName(claims);
  const displayName = resolvedName ?? t("home.welcome_fallback_name");

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

      {tenantNameMissing && (
        <Alert type="warning" header={t("home.tenant_name_missing_header")}>
          {t("home.tenant_name_missing_body")}
        </Alert>
      )}

      <Container header={<Header variant="h2">{t("home.catalog_header")}</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Stat label={t("home.stat_total")} value={String(totalCount)} />
          <Stat label={t("home.stat_ready")} value={String(readyCount)} />
          <Stat label={t("home.stat_draft")} value={String(draftCount)} />
          <Stat label={t("home.stat_battle")} value={String(battleCount)} />
        </ColumnLayout>
      </Container>

      {!onboardingDismissed && (
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={() => navigate("/problems")}>
                    {t("home.next_action_view_all")}
                  </Button>
                  <Button
                    iconName="close"
                    variant="icon"
                    ariaLabel={t("home.next_action_close_aria")}
                    onClick={() => {
                      writeOnboardingDismissed(true);
                      setOnboardingDismissed(true);
                    }}
                  />
                </SpaceBetween>
              }
            >
              {t("home.next_action_header")}
            </Header>
          }
        >
          <Box variant="p">{t("home.next_action_body")}</Box>
        </Container>
      )}

      <Container header={<Header variant="h2">{t("home.tenant_info_header")}</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValue
            label={t("home.tenant_info_name")}
            value={tenantName ?? t("home.value_unset")}
          />
          <KeyValue label={t("home.tenant_info_id")} value={tenantId ?? t("home.value_unknown")} />
          <KeyValue
            label={t("home.tenant_info_tier")}
            valueNode={
              tenantTier ? <Badge>{tenantTier}</Badge> : <span>{t("home.value_unknown")}</span>
            }
          />
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
      {valueNode ?? <Box variant="p">{value}</Box>}
    </div>
  );
}
