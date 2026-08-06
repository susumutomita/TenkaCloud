import Alert from "@cloudscape-design/components/alert";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { type ShellUserMenu, ShellLayout as WebKitShellLayout } from "@tenkacloud/web-kit";
import { Fragment, type ReactNode, useReducer } from "react";
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
 *
 * shell 構造 (TopNav + SideNav + AppLayout) は @tenkacloud/web-kit の ShellLayout に集約し、
 * ここでは admin-console との差分 (= product title + user-menu + per-app nav) だけを props で渡す。
 */
export function ShellLayout({
  children,
  samlSsoEnabled = false,
  demoMode = false,
  demoParticipantUrl,
}: {
  children: ReactNode;
  /** Feature-flagged: show the Identity providers (SAML SSO) nav item only when enabled. */
  samlSsoEnabled?: boolean;
  /** Issue #1954: no-AWS demo mode の常時バナーを出す。 */
  demoMode?: boolean;
  /** Issue #1954: 参加者 demo (participant-portal) への hand-off 先 base URL。 */
  demoParticipantUrl?: string;
}) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();
  const [contentRevision, refreshContent] = useReducer((revision: number) => revision + 1, 0);

  const onSignOut = () => {
    auth.logout();
    navigate("/login");
  };

  // Issue #831: sign-in user (= email) を TopNav 右上に menu-dropdown で出す。
  // 旧 Home page の "サインインユーザー" KeyValue は削除し、 ここに移動する。
  const claims = auth.tokens ? decodeIdToken(auth.tokens.idToken) : null;
  const userEmail = claims?.email;
  const userMenu: ShellUserMenu | undefined = userEmail
    ? {
        label: userEmail,
        ariaLabel: t("nav.user_menu_aria", { userEmail }),
        signOutLabel: t("auth.sign_out"),
      }
    : undefined;

  return (
    <WebKitShellLayout<LocaleCode>
      title={t("app.title")}
      navHeaderText={t("nav.menu")}
      navItems={[
        { type: "link", href: "/", text: t("nav.home") },
        // Product-design pass: users first choose between the operator's two primary
        // jobs (run an event / prepare content), then secondary operations. This keeps
        // the left rail from looking like one undifferentiated list of destinations.
        {
          type: "section",
          text: t("nav.event_ops_section"),
          items: [
            { type: "link", href: "/events", text: t("nav.events") },
            { type: "link", href: "/deployments", text: t("nav.deployments") },
            { type: "link", href: "/competitor-accounts", text: t("nav.competitor_accounts") },
          ],
        },
        {
          type: "section",
          text: t("nav.content_section"),
          items: [{ type: "link", href: "/problems", text: t("nav.problems") }],
        },
        // 管理系 (監査ログ / IdP) は日常運用メニューと混ざると見つけにくいので、 1 つの
        // category section にまとめて flat な羅列を解消する。
        {
          type: "section",
          text: t("nav.admin_section"),
          items: [
            // Issue #1292: 自テナント監査ログ (= deploy / event 操作の audit)。
            { type: "link", href: "/audit-log", text: t("nav.audit_log") },
            { type: "link", href: "/users", text: t("nav.tenant_users") },
            // Issue #2231: per-tenant runtime feature-flag toggle.
            { type: "link", href: "/settings", text: t("nav.settings") },
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
      activeHref={location.pathname}
      onNavigate={(href) => navigate(href)}
      isAuthenticated={Boolean(auth.tokens)}
      onSignOut={onSignOut}
      userMenu={userMenu}
      refreshAction={{ label: t("nav.refresh_latest"), onRefresh: refreshContent }}
      locale={locale}
      setLocale={setLocale}
      t={t}
      supportedLocales={SUPPORTED_LOCALES}
      localeNames={LOCALE_NAME}
      localeSwitcherAriaLabel={t("nav.locale_switcher_aria")}
    >
      <Fragment key={contentRevision}>
        {demoMode ? (
          <SpaceBetween size="m">
            <Alert type="info" header={t("demo.banner_header")}>
              <SpaceBetween size="xs">
                <span>{t("demo.banner_body")}</span>
                {demoParticipantUrl && (
                  <Link href={`${demoParticipantUrl}/?demo=1`} external>
                    {t("demo.view_as_participant")}
                  </Link>
                )}
              </SpaceBetween>
            </Alert>
            {children}
          </SpaceBetween>
        ) : (
          children
        )}
      </Fragment>
    </WebKitShellLayout>
  );
}
