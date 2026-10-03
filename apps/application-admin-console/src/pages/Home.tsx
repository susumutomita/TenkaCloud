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

/** Organizer landing page for a single competition installation. */
export function HomePage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const t = useT();
  const claims = auth.tokens ? decodeIdToken(auth.tokens.idToken) : null;
  const displayName = claims?.email ?? t("home.welcome_fallback_name");

  const problems = listProblemSummaries();
  const totalCount = problems.length;
  const battleCount = problems.filter((p) => p.category === "Battle").length;
  const challengeCount = problems.filter((p) => p.category === "Challenge").length;

  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" onClick={() => navigate("/problems")}>
            {t("home.open_catalog")}
          </Button>
        }
      >
        {t("home.welcome", { displayName })}
      </Header>

      <Container header={<Header variant="h2">{t("home.catalog_header")}</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <Stat label={t("home.stat_total")} value={String(totalCount)} />
          <Stat label={t("home.stat_battle")} value={String(battleCount)} />
          <Stat label={t("home.stat_challenge")} value={String(challengeCount)} />
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
