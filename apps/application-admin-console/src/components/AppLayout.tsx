import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import { tenkaCloudAppIconDataUri } from "@tenkacloud/web-kit";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n } from "../i18n";

/** Issue #583 Phase 1.C: locale switcher display 名 map (= 各 locale.json と同期)。 */
const LOCALE_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
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
  children,
  samlSsoEnabled = false,
}: {
  children: ReactNode;
  /** Feature-flagged: show the Identity providers (SAML SSO) nav item only when enabled. */
  samlSsoEnabled?: boolean;
}) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();

  // Issue #831: sign-in user (= email) を TopNav 右上に menu-dropdown で出す。
  // 旧 Home page の \"サインインユーザー\" KeyValue は削除し、 ここに移動する。
  const claims = auth.tokens ? decodeIdToken(auth.tokens.idToken) : null;
  const userEmail = claims?.email;
  const userMenuUtility: TopNavigationProps.Utility | undefined = userEmail
    ? {
        type: "menu-dropdown",
        iconName: "user-profile",
        text: userEmail,
        ariaLabel: t("nav.user_menu_aria", { userEmail }),
        items: [
          {
            id: "signout",
            text: t("auth.sign_out"),
            iconName: "external",
          },
        ],
        onItemClick: ({ detail }) => {
          // user menu の item は signout のみなので detail.id は常に "signout" (= 偽は不到達)。
          /* v8 ignore next */
          if (detail.id === "signout") {
            auth.logout();
            navigate("/login");
          }
        },
      }
    : undefined;

  const localeUtility: TopNavigationProps.Utility = {
    type: "menu-dropdown",
    iconName: "globe",
    ariaLabel: t("nav.locale_switcher_aria"),
    // locale / code は SUPPORTED_LOCALES = LOCALE_NAME の key と一致するので ?? の右辺は不到達
    // (= noUncheckedIndexedAccess 下で型を満たすための防御的フォールバック)。
    /* v8 ignore next */
    text: LOCALE_NAME[locale] ?? locale,
    /* v8 ignore next */
    items: SUPPORTED_LOCALES.map((code) => ({ id: code, text: LOCALE_NAME[code] ?? code })),
    onItemClick: ({ detail }) => {
      // items は SUPPORTED_LOCALES のみなので detail.id は常に既知 locale (= includes 偽は不到達)。
      /* v8 ignore next */
      if ((SUPPORTED_LOCALES as readonly string[]).includes(detail.id)) {
        setLocale(detail.id as LocaleCode);
      }
    },
  };

  return (
    <>
      <TopNavigation
        identity={{
          href: "/",
          title: t("app.title"),
          logo: { src: tenkaCloudAppIconDataUri, alt: "TenkaCloud" },
        }}
        utilities={
          // Issue #831: 右上 utility は (locale, user-menu) の順。 旧 \"サインアウト\" は
          // user-menu の中に格納し、 user email を表に出す。 未 sign-in 時は locale のみ。
          auth.tokens
            ? userMenuUtility
              ? [localeUtility, userMenuUtility]
              : [
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
              { type: "link", href: "/", text: t("nav.home") },
              { type: "link", href: "/events", text: t("nav.events") },
              { type: "link", href: "/problems", text: t("nav.problems") },
              { type: "link", href: "/deployments", text: t("nav.deployments") },
              { type: "link", href: "/competitor-accounts", text: t("nav.competitor_accounts") },
              // 管理系 (監査ログ / IdP) は日常運用メニューと混ざると見つけにくいので、 1 つの
              // category section にまとめて flat な羅列を解消する。
              {
                type: "section",
                text: t("nav.admin_section"),
                items: [
                  // Issue #1292: 自テナント監査ログ (= deploy / event 操作の audit)。
                  { type: "link", href: "/audit-log", text: t("nav.audit_log") },
                  { type: "link", href: "/users", text: t("nav.tenant_users") },
                  // Issue #1294: per-tenant SAML SSO. Feature-flagged off until verified
                  // end-to-end (otherwise operators mistake an unproven feature for ready).
                  ...(samlSsoEnabled
                    ? [
                        {
                          type: "link" as const,
                          href: "/identity-providers",
                          text: t("nav.identity_providers"),
                        },
                      ]
                    : []),
                ],
              },
            ]}
            onFollow={(e) => {
              // SideNavigation の link は全て internal (external:true なし) なので偽は不到達。
              /* v8 ignore next */
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
