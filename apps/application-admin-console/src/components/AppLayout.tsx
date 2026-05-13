import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n } from "../i18n";

/** Issue #583 Phase 1.C: locale switcher display 名 map (= 各 locale.json と同期)。 */
const LOCALE_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
  es: "Español",
  zh: "中文",
};

/**
 * application-admin-console の shell。TopNavigation はサインアウトのみ、
 * SideNavigation は ホーム / 問題 (catalog)。今後の PR で「競技イベント」「参加者」等が増える。
 *
 * テナント名は build 時 config.tenantName が pooled stack だと "Shared Pooled Tenant"
 * placeholder のまま漏れるので、ここでは表示しない。Home ページ側で JWT custom 属性
 * (custom:tenantId / 将来 custom:tenantName) からユーザの所属テナントを描画する。
 */
export function ShellLayout({
  config: _config,
  children,
}: {
  config: AppConfig;
  children: ReactNode;
}) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();

  const localeUtility: TopNavigationProps.Utility = {
    type: "menu-dropdown",
    iconName: "globe",
    ariaLabel: "言語切替 / Language",
    text: LOCALE_NAME[locale] ?? locale,
    items: SUPPORTED_LOCALES.map((code) => ({ id: code, text: LOCALE_NAME[code] ?? code })),
    onItemClick: ({ detail }) => {
      if ((SUPPORTED_LOCALES as readonly string[]).includes(detail.id)) {
        setLocale(detail.id as LocaleCode);
      }
    },
  };

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: t("app.title") }}
        utilities={
          auth.tokens
            ? [
                localeUtility,
                {
                  type: "button",
                  text: t("auth.sign_out"),
                  onClick: () => {
                    auth.logout();
                    navigate("/login");
                  },
                },
              ]
            : [localeUtility]
        }
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: t("nav.menu") }}
            items={[
              { type: "link", href: "/", text: "ホーム" },
              { type: "link", href: "/events", text: t("nav.events") },
              { type: "link", href: "/problems", text: t("nav.problems") },
              { type: "link", href: "/deployments", text: t("nav.deployments") },
              { type: "link", href: "/competitor-accounts", text: "Competitor Accounts" },
            ]}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                navigate(e.detail.href);
              }
            }}
          />
        }
        content={children}
        toolsHide
      />
    </>
  );
}
