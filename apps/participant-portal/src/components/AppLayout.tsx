import Alert from "@cloudscape-design/components/alert";
import AppLayout from "@cloudscape-design/components/app-layout";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import SideNavigation, {
  type SideNavigationProps,
} from "@cloudscape-design/components/side-navigation";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import { createTenkaCloudTopNavigationIdentity } from "@tenkacloud/web-kit";
import { type ReactNode, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import type { LeaderboardResponse, ParticipantTeamView } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { TeamViewProvider, useTeamView } from "../auth/TeamViewProvider";
import { type AppConfig, type CloudMode, showsCourseTracks } from "../config";
import { problemProvider } from "../data/providers";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n } from "../i18n";
import { CountdownTimer } from "./CountdownTimer";
import {
  buildLocaleUtility,
  LOCALE_DICTIONARIES_NAME,
  LOCALE_NAV_HREF_PREFIX,
  localeFromNavHref,
} from "./locale-switcher";
import { useConsoleAccess } from "./useConsoleAccess";

type Translate = (key: string) => string;

export function formatTopNavScore(
  mode: AppConfig["mode"],
  view: ParticipantTeamView | null,
): string {
  if (mode !== "backend") return "—";
  if (!view) return "…";
  const totalScore = view.problems.reduce((sum, p) => sum + p.score, 0);
  return `${totalScore} pt`;
}

export function formatTopNavRank(
  mode: AppConfig["mode"],
  leaderboard: LeaderboardResponse | null,
  leaderboardNoEvent: boolean,
): string {
  if (mode !== "backend" || leaderboardNoEvent) return "—";
  const myEntry = leaderboard?.entries.find((e) => e.isMyTeam);
  const totalEntries = leaderboard?.entries.length;
  return myEntry && totalEntries ? `${myEntry.rank}/${totalEntries}` : "…";
}

export function buildScoreRankUtility(
  score: string,
  rank: string,
  navigate: (href: string) => void,
): TopNavigationProps.Utility {
  return {
    type: "button",
    text: `Score: ${score}  /  Rank: ${rank}`,
    iconName: "status-positive",
    onClick: () => {
      navigate("/scoreboard");
    },
  };
}

export function buildRefreshLatestUtility(
  refresh: () => Promise<void>,
  t: Translate,
): TopNavigationProps.Utility {
  return {
    type: "button",
    text: t("nav.refresh_latest"),
    iconName: "refresh",
    onClick: () => {
      void refresh();
    },
  };
}

export function buildAutoRefreshUtility(
  enabled: boolean,
  setEnabled: (next: boolean) => void,
  t: Translate,
): TopNavigationProps.Utility {
  return {
    type: "button",
    text: enabled ? t("nav.auto_refresh_on") : t("nav.auto_refresh_off"),
    iconName: enabled ? "status-positive" : "status-stopped",
    onClick: () => {
      setEnabled(!enabled);
    },
  };
}

/**
 * Issue #1191: profile dropdown のメニュー項目を再利用可能な pure function で組む
 * (= unit test で項目構成を pin)。 競技者は「チーム名を変更」「サインアウト」の 2 つを
 * 選べる。
 */
export function buildProfileMenuItems(
  t: Translate,
): readonly { readonly id: string; readonly text: string }[] {
  return [
    { id: "change_team_name", text: t("nav.change_team_name") },
    { id: "logout", text: t("nav.sign_out") },
  ];
}

/**
 * profile dropdown の item click handler。 `id` ごとに副作用を分岐する pure
 * dispatcher (unit test 可能)。
 */
export function handleProfileMenuClick(
  id: string,
  deps: { readonly logout: () => void; readonly navigate: (href: string) => void },
): void {
  if (id === "change_team_name") {
    deps.navigate("/setup");
    return;
  }
  if (id === "logout") {
    deps.logout();
    deps.navigate("/login");
  }
}

/**
 * Issue #1919: AWS Console への入口を右上 TopNavigation に常設する (GameDay 風)。
 * 旧来は左ナビ「ツール → SSO 資格情報」ページ内のボタンに埋もれて競技者が気づけなかった。
 *
 * - deploy 済み (awsAccountId 付き) 問題が 1 つ → button でその問題の Console を直接開く。
 * - 複数 → menu-dropdown で問題を選ばせてから開く。
 * - 0 (まだ deploy 前) → SSO 資格情報ページへ誘導し「常設の入口」を維持する。
 *
 * Console は `ConsoleViewerRole` (= ReadOnlyAccess) なので read は十分広い。
 */
export function buildConsoleUtility(
  problems: readonly {
    readonly jobId: string;
    readonly problemId: string;
    readonly awsAccountId?: string;
    readonly provider?: string;
  }[],
  openConsole: (jobId: string) => void,
  navigate: (href: string) => void,
  t: Translate,
): TopNavigationProps.Utility {
  // [#2234] 非 AWS 行も deploy request 由来の awsAccountId を持つため、 provider でゲートする
  // (= Sakura/Azure/GCP 問題に "Open AWS Console" を誤表示しない、 ADR-0001 の matrix)。
  const consolable = problems.filter((p) => problemProvider(p) === "aws" && p.awsAccountId);
  if (consolable.length === 0) {
    return {
      type: "button",
      text: t("nav.open_console"),
      iconName: "external",
      onClick: () => navigate("/tools/sso"),
    };
  }
  if (consolable.length === 1) {
    const only = consolable[0];
    return {
      type: "button",
      text: t("nav.open_console"),
      iconName: "external",
      onClick: () => openConsole(only.jobId),
    };
  }
  return {
    type: "menu-dropdown",
    text: t("nav.open_console"),
    iconName: "external",
    items: consolable.map((p) => ({ id: p.jobId, text: p.problemId })),
    onItemClick: ({ detail }) => openConsole(detail.id),
  };
}

export function buildProfileUtility(
  teamName: string,
  logout: () => void,
  navigate: (href: string) => void,
  t: Translate,
): TopNavigationProps.Utility {
  return {
    type: "menu-dropdown",
    text: teamName,
    iconName: "user-profile",
    items: buildProfileMenuItems(t),
    onItemClick: ({ detail }) => handleProfileMenuClick(detail.id, { logout, navigate }),
  };
}

function OfflineCloudModeAlert({ config }: { config: AppConfig }) {
  const { t } = useI18n();
  if (config.cloudMode === "real") return null;
  if (config.cloudMode === "local") {
    return (
      <Alert type="warning" header={t("app.local_cloud_header")}>
        {t("app.local_cloud_body")}
      </Alert>
    );
  }
  return (
    <Alert type="info" header={t("app.mock_cloud_header")}>
      {t("app.mock_cloud_body")}
    </Alert>
  );
}

/**
 * SideNavigation の link click handler。 内部リンクは SPA navigate に差し替え、 external は
 * ブラウザ既定に任せる (= unit test 可能な pure dispatcher として切り出し)。
 */
export function handleSideNavFollow(
  event: {
    readonly preventDefault: () => void;
    readonly detail: { readonly external?: boolean; readonly href: string };
  },
  navigate: (href: string) => void,
  setLocale: (locale: LocaleCode) => void,
): void {
  if (event.detail.external) return;
  event.preventDefault();
  // #2711 follow-up: `#locale-<code>` は画面遷移ではなく locale 切替 (モバイル用導線)。
  const locale = localeFromNavHref(event.detail.href);
  if (locale) {
    setLocale(locale);
    return;
  }
  navigate(event.detail.href);
}

/**
 * Participant Portal の shell。AWS GameDay の参考画面に倣って TopNavigation +
 * 3 セクション SideNavigation (Event / Quests / Tools) を組み立てる。
 *
 * Score / Rank はどちらも `TeamViewProvider` 経由で `/portal/me` + `/portal/leaderboard`
 * の取得結果を共有 (Home の累計スコアパネル / Scoreboard と同 source)。Rank は
 * 自チーム (`isMyTeam`) の rank / total entries で表示。Phase 1 以前の旧 deployment
 * (eventId 無し) は leaderboard 不能なので "—" で fallback。
 * 30s polling は DynamoDB cost guardrail のため default off。TopNavigation から opt-in する。
 */

/**
 * SideNavigation items (notifications 未読 badge 用に動的構築)。`unread` を渡して
 * `info` バッジに件数を出す。> 99 は "99+" にクランプして badge 横幅を一定にする。
 *
 * Issue #2474: `cloudMode === "local"` (単独ドリル) は主催者アナウンスも federate 先の
 * AWS も無いため、 AWS 専用の導線を出さない — `Tools` セクション (SSO 資格情報) を丸ごと省き、
 * `Event` セクションから `notifications` link を落とす (unread badge 計算も local では不要)。
 * `mock` (dev-mock) / `real` は従来どおり全導線を出す。
 */
export function buildSideNavItems(
  unread: number,
  t: (key: string) => string,
  cloudMode: CloudMode,
  locale: LocaleCode,
): SideNavigationProps.Item[] {
  const isLocal = cloudMode === "local";
  const eventItems: SideNavigationProps.Item[] = [
    { type: "link", href: "/", text: t("nav.home") },
    { type: "link", href: "/scoreboard", text: t("nav.scoreboard") },
    { type: "link", href: "/score-events", text: t("nav.score_events") },
  ];
  if (!isLocal) {
    eventItems.push({
      type: "link",
      href: "/notifications",
      text: t("nav.notifications"),
      info:
        unread > 0 ? <Badge color="red">{unread > 99 ? "99+" : String(unread)}</Badge> : undefined,
    });
  }
  const sections: SideNavigationProps.Item[] = [
    { type: "section", text: t("nav.event_section"), items: eventItems },
    {
      type: "section",
      text: t("nav.quests_section"),
      items: [
        // [#2882] 講座トラックは自習経路なので local だけ (判定は `showsCourseTracks`)。
        // local では**先に**置く: 後ろだと学習者は先に出るフラットな一覧に着き、 71 件を前に
        // 「何をやればいいか分からない」で止まる。 並び順そのものが導線になっている。
        ...(showsCourseTracks(cloudMode)
          ? [{ type: "link" as const, href: "/course-tracks", text: t("nav.course_tracks") }]
          : []),
        { type: "link", href: "/problems", text: t("nav.problems") },
      ],
    },
  ];
  if (!isLocal) {
    sections.push({
      type: "section",
      text: t("nav.tools_section"),
      items: [{ type: "link", href: "/tools/sso", text: t("nav.sso_credentials") }],
    });
  }
  // #2711 follow-up: モバイル幅では TopNavigation の utilities (globe dropdown) が畳まれて
  // 言語切替に到達できないため、 ハンバーガーで常に開ける side nav にも切替を置く。
  sections.push({
    type: "section",
    text: t("nav.language_section"),
    items: SUPPORTED_LOCALES.map((code) => ({
      type: "link",
      href: `${LOCALE_NAV_HREF_PREFIX}${code}`,
      text: `${locale === code ? "✓ " : ""}${LOCALE_DICTIONARIES_NAME[code]}`,
    })),
  });
  return sections;
}

export function ShellLayout({ config, children }: { config: AppConfig; children: ReactNode }) {
  return (
    <TeamViewProvider config={config}>
      <ShellInner config={config}>{children}</ShellInner>
    </TeamViewProvider>
  );
}

function ShellInner({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const teamView = useTeamView();

  const { locale, setLocale, t } = useI18n();
  const consoleAccess = useConsoleAccess(config);

  const utilities = useMemo<TopNavigationProps.Utility[]>(() => {
    // Issue #583 Phase 1.A: locale switcher utility は session 有無に依存しない (= ログイン
    // 前 / login page でも切替可能)。
    const localeUtility = buildLocaleUtility(locale, setLocale, t);
    if (!auth.session) return [localeUtility];
    // Score: backend mode のときだけ実値、未取得なら "…"、dev-mock なら "—"。
    const score = formatTopNavScore(config.mode, teamView.view);
    // Rank: leaderboard.entries.find(isMyTeam) の rank / 全 entries 数。
    // Phase 1 以前 (eventId 無し) は leaderboardNoEvent → "—"、未取得は "…"。
    const rank = formatTopNavRank(config.mode, teamView.leaderboard, teamView.leaderboardNoEvent);
    return [
      localeUtility,
      // Issue #1919: AWS Console 導線を右上常設にして「入口が分からない」を解消する。
      // Issue #2474: ただし local (単独ドリル) は federate 先の AWS が無く Console を開けない
      // (= "Portal API 404") ので、 local のときは常設 utility から外す。
      ...(config.cloudMode === "local"
        ? []
        : [
            buildConsoleUtility(
              teamView.view?.problems ?? [],
              consoleAccess.openConsole,
              navigate,
              t,
            ),
          ]),
      buildRefreshLatestUtility(teamView.refresh, t),
      buildAutoRefreshUtility(teamView.autoRefreshEnabled, teamView.setAutoRefreshEnabled, t),
      // #547: 旧 `menu-dropdown` + 空 items は chevron で展開できそうに見えて何も出ない
      // という UX bug。Score / Rank の click は scoreboard ページへの遷移が自然なので
      // `type: "button"` + onClick で /scoreboard に飛ばす (= dropdown の意図不明
      // affordance を排除)。
      buildScoreRankUtility(score, rank, navigate),
      buildProfileUtility(auth.session.teamName, auth.logout, navigate, t),
    ];
  }, [
    auth.session,
    auth.logout,
    navigate,
    consoleAccess.openConsole,
    teamView.refresh,
    teamView.autoRefreshEnabled,
    teamView.setAutoRefreshEnabled,
    teamView.view,
    teamView.leaderboard,
    teamView.leaderboardNoEvent,
    config.mode,
    config.cloudMode,
    locale,
    setLocale,
    t,
  ]);

  const sideNavItems = useMemo(
    () => buildSideNavItems(teamView.unreadNotificationCount, t, config.cloudMode, locale),
    [teamView.unreadNotificationCount, t, config.cloudMode, locale],
  );

  return (
    <>
      <TopNavigation
        identity={createTenkaCloudTopNavigationIdentity(config.eventTitle)}
        utilities={utilities}
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: t("nav.menu_header") }}
            items={sideNavItems}
            onFollow={(e) => handleSideNavFollow(e, navigate, setLocale)}
          />
        }
        content={
          <SpaceBetween size="m">
            <OfflineCloudModeAlert config={config} />
            {/* Issue #1919: 右上常設 Console 導線の open 失敗 / mock blocked を全画面共通で
             *  表示する (TopNavigation の utility は Alert を出せないため content 側に置く)。 */}
            {consoleAccess.error && (
              <Alert
                type={consoleAccess.error.isMock ? "info" : "error"}
                header={
                  consoleAccess.error.isMock
                    ? t("sso_credentials.mock_open_header")
                    : t("sso_credentials.open_failed_header")
                }
                dismissible
                onDismiss={consoleAccess.dismissError}
              >
                {consoleAccess.error.message}
              </Alert>
            )}
            {/* Issue #1349: 全画面共通の event countdown を header 下に固定。 endsAt が
             *  legacy deployment で undefined のときは CountdownTimer 自身が null を返す。 */}
            <Box float="right">
              <CountdownTimer endsAt={teamView.leaderboard?.endsAt} />
            </Box>
            {auth.session === null ? (
              <Box variant="strong" color="text-status-warning">
                {t("app.no_session")}
              </Box>
            ) : null}
            {children}
          </SpaceBetween>
        }
        toolsHide
      />
    </>
  );
}
