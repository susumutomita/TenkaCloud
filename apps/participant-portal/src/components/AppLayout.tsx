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
import { type ReactNode, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { TeamViewProvider, useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n } from "../i18n";

/**
 * Issue #583 Phase 1.A: locale switcher の display 名 map。 各 locale.json 内
 * `locale.name` を import せず literal で持つ (= bundle size 抑制 / 起動時依存削減)。
 */
const LOCALE_DICTIONARIES_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
  es: "Español",
  zh: "中文",
};

/**
 * Participant Portal の shell。AWS GameDay の参考画面に倣って TopNavigation +
 * 3 セクション SideNavigation (Event / Quests / Tools) を組み立てる。
 *
 * Score / Rank はどちらも `TeamViewProvider` 経由で `/portal/me` + `/portal/leaderboard`
 * の polling 結果を共有 (Home の累計スコアパネル / Scoreboard と同 source)。Rank は
 * 自チーム (`isMyTeam`) の rank / total entries で表示。Phase 1 以前の旧 deployment
 * (eventId 無し) は leaderboard 不能なので "—" で fallback。
 */

/**
 * SideNavigation items (notifications 未読 badge 用に動的構築)。`unread` を渡して
 * `info` バッジに件数を出す。> 99 は "99+" にクランプして badge 横幅を一定にする。
 */
function buildSideNavItems(unread: number, t: (key: string) => string): SideNavigationProps.Item[] {
  const notificationsLink: SideNavigationProps.Link = {
    type: "link",
    href: "/notifications",
    text: t("nav.notifications"),
    info:
      unread > 0 ? <Badge color="red">{unread > 99 ? "99+" : String(unread)}</Badge> : undefined,
  };
  return [
    {
      type: "section",
      text: t("nav.event_section"),
      items: [
        { type: "link", href: "/", text: t("nav.home") },
        { type: "link", href: "/scoreboard", text: t("nav.scoreboard") },
        { type: "link", href: "/score-events", text: t("nav.score_events") },
        notificationsLink,
      ],
    },
    {
      type: "section",
      text: t("nav.quests_section"),
      items: [{ type: "link", href: "/problems", text: t("nav.problems") }],
    },
    {
      type: "section",
      text: t("nav.tools_section"),
      items: [{ type: "link", href: "/tools/sso", text: t("nav.sso_credentials") }],
    },
  ];
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

  const utilities = useMemo<TopNavigationProps.Utility[]>(() => {
    // Issue #583 Phase 1.A: locale switcher utility は session 有無に依存しない (= ログイン
    // 前 / login page でも切替可能)。
    const localeUtility: TopNavigationProps.Utility = {
      type: "menu-dropdown",
      iconName: "globe",
      ariaLabel: t("switcher.aria_label"),
      text: LOCALE_DICTIONARIES_NAME[locale] ?? locale,
      items: SUPPORTED_LOCALES.map((code) => ({
        id: code,
        text: LOCALE_DICTIONARIES_NAME[code] ?? code,
      })),
      onItemClick: ({ detail }) => {
        if ((SUPPORTED_LOCALES as readonly string[]).includes(detail.id)) {
          setLocale(detail.id as LocaleCode);
        }
      },
    };
    if (!auth.session) return [localeUtility];
    // Score: backend mode のときだけ実値、未取得なら "…"、dev-mock なら "—"。
    const totalScore = teamView.view
      ? teamView.view.problems.reduce((sum, p) => sum + p.score, 0)
      : null;
    const score =
      config.mode === "backend" ? (totalScore !== null ? `${totalScore} pt` : "…") : "—";
    // Rank: leaderboard.entries.find(isMyTeam) の rank / 全 entries 数。
    // Phase 1 以前 (eventId 無し) は leaderboardNoEvent → "—"、未取得は "…"。
    const myEntry = teamView.leaderboard?.entries.find((e) => e.isMyTeam);
    const totalEntries = teamView.leaderboard?.entries.length;
    const rank =
      config.mode !== "backend"
        ? "—"
        : teamView.leaderboardNoEvent
          ? "—"
          : myEntry && totalEntries
            ? `${myEntry.rank}/${totalEntries}`
            : "…";
    return [
      localeUtility,
      // #547: 旧 `menu-dropdown` + 空 items は chevron で展開できそうに見えて何も出ない
      // という UX bug。Score / Rank の click は scoreboard ページへの遷移が自然なので
      // `type: "button"` + onClick で /scoreboard に飛ばす (= dropdown の意図不明
      // affordance を排除)。
      {
        type: "button",
        text: `Score: ${score}  /  Rank: ${rank}`,
        iconName: "status-positive",
        onClick: () => {
          navigate("/scoreboard");
        },
      },
      {
        type: "menu-dropdown",
        text: auth.session.teamName,
        iconName: "user-profile",
        items: [{ id: "logout", text: t("nav.sign_out") }],
        onItemClick: ({ detail }) => {
          if (detail.id === "logout") {
            auth.logout();
            navigate("/login");
          }
        },
      },
    ];
  }, [
    auth.session,
    auth.logout,
    navigate,
    teamView.view,
    teamView.leaderboard,
    teamView.leaderboardNoEvent,
    config.mode,
    locale,
    setLocale,
    t,
  ]);

  const sideNavItems = useMemo(
    () => buildSideNavItems(teamView.unreadNotificationCount, t),
    [teamView.unreadNotificationCount, t],
  );

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: `TenkaCloud — ${config.eventTitle}` }}
        utilities={utilities}
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: t("nav.menu_header") }}
            items={sideNavItems}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                navigate(e.detail.href);
              }
            }}
          />
        }
        content={
          <SpaceBetween size="m">
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
