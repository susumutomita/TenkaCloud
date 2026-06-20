import { ShellLayout as WebKitShellLayout } from "@tenkacloud/web-kit";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n } from "../i18n";

/** Issue #583 Phase 1.B: locale switcher の display 名 map (= 各 locale.json と同期)。 */
const LOCALE_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
};

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

  return (
    <WebKitShellLayout<LocaleCode>
      title={t("app.title")}
      navHeaderText={t("nav.menu")}
      navItems={[
        { type: "link", href: "/tenants", text: t("nav.tenants") },
        { type: "link", href: "/tenants/new", text: t("nav.tenants_new") },
        // Issue #1767: tenant usage dashboard (AdminInsight 集計の横断ビュー)
        { type: "link", href: "/usage", text: t("nav.usage") },
        { type: "link", href: "/jobs", text: t("nav.jobs") },
        { type: "link", href: "/audit-log", text: t("nav.audit_log") },
        // SAML SSO is feature-flagged off until verified (ADR-035) — hide the nav item.
        ...(samlSsoEnabled
          ? [
              {
                type: "link" as const,
                href: "/identity-providers",
                text: t("nav.identity_providers"),
              },
            ]
          : []),
        { type: "link", href: "/operations", text: t("nav.operations") },
      ]}
      activeHref={location.pathname}
      onNavigate={(href) => navigate(href)}
      isAuthenticated={Boolean(auth.tokens)}
      onSignOut={() => {
        auth.logout();
        navigate("/login");
      }}
      locale={locale}
      setLocale={setLocale}
      t={t}
      supportedLocales={SUPPORTED_LOCALES}
      localeNames={LOCALE_NAME}
      localeSwitcherAriaLabel="言語切替 / Language"
    >
      {children}
    </WebKitShellLayout>
  );
}
