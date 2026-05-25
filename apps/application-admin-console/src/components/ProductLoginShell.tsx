/**
 * Issue #1329: 商用 grade のログイン画面 shell。
 *
 * LP (`landing/`) と同じ branding を SPA のログイン画面にも適用する。 admin-console
 * (System Admin) / application-admin-console (Tenant Admin) は構造が同一なので、
 * 各 app に同名の component を置き、 props (= title / subtitle) で差し替える。
 *
 * 設計判断:
 *   - Cloudscape の Container / Header / Button だけで組み立てる (= 新 dep 0)
 *   - LP の Inter / Noto Sans JP は OS font fallback に任せる (= preconnect しない)
 *   - Footer の legal リンクは LP の本物 URL (https://tenkacloud.cloud/) を指す
 *   - i18n switch UI を内蔵 (Cognito redirect 前なので AppLayout の switcher が無い)
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n, useT } from "../i18n";

/**
 * LP の <nav class="brand">TenkaCloud</nav> と意匠を揃えた wordmark。
 * 円形マーク + ワードマークの 2 column。 svg viewBox を 40 高に固定。
 */
function TenkaCloudWordmark() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        color: "#07111f",
      }}
    >
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" focusable="false">
        <title>TenkaCloud logo</title>
        <defs>
          <linearGradient id="tc-mark-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0969da" />
            <stop offset="100%" stopColor="#08111f" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="18" fill="url(#tc-mark-grad)" />
        <path
          d="M12 18 L20 12 L28 18 L28 28 L22 28 L22 22 L18 22 L18 28 L12 28 Z"
          fill="#ffffff"
          opacity="0.95"
        />
      </svg>
      <span
        style={{
          fontFamily:
            "Inter, 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: "-0.02em",
        }}
      >
        TenkaCloud
      </span>
    </div>
  );
}

const LEGAL_LINKS = {
  privacy: "https://tenkacloud.cloud/privacy.html",
  terms: "https://tenkacloud.cloud/terms.html",
  tokushoho: "https://tenkacloud.cloud/legal.html",
} as const;

export interface ProductLoginShellProps {
  /** ページ見出し。 e.g. "TenkaCloud System Admin Console" */
  readonly title: string;
  /** 見出し直下の説明。 dev jargon を排除した一文。 */
  readonly subtitle: string;
  /** ボタン文言 (= 「サインイン」 / "Sign in")。 */
  readonly signInLabel: string;
  /** signing-in state の表示文言。 */
  readonly signingInLabel: string;
  /** Cognito Hosted UI へ redirect を開始するハンドラ。 */
  readonly onSignIn: () => void | Promise<void>;
  /** 旧 idle state で fire-and-forget submit を防ぐためのフラグ。 */
  readonly signingIn: boolean;
  /** beginLogin が throw した場合に表示する一行メッセージ。 */
  readonly errorMessage?: string;
}

export function ProductLoginShell(props: ProductLoginShellProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at 20% 10%, #eef5ff 0%, #f6f7fb 45%, #ffffff 100%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 24px",
        }}
      >
        <TenkaCloudWordmark />
        <fieldset
          aria-label={t("login.language_switcher_aria")}
          style={{
            display: "flex",
            gap: 4,
            border: "none",
            padding: 0,
            margin: 0,
          }}
        >
          {SUPPORTED_LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLocale(code as LocaleCode)}
              aria-pressed={locale === code}
              style={{
                background: locale === code ? "#0969da" : "transparent",
                color: locale === code ? "#ffffff" : "#5d6877",
                border: locale === code ? "1px solid #0969da" : "1px solid #c8d0db",
                borderRadius: 999,
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {code === "ja" ? "日本語" : "English"}
            </button>
          ))}
        </fieldset>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 16px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 480 }}>
          <Container>
            <SpaceBetween size="l">
              <div>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 24,
                    fontWeight: 800,
                    letterSpacing: "-0.02em",
                    color: "#07111f",
                  }}
                >
                  {props.title}
                </h1>
                <Box variant="p" margin={{ top: "s" }} color="text-body-secondary">
                  {props.subtitle}
                </Box>
              </div>

              {props.errorMessage ? (
                <Alert type="error" header={t("login.error_header")}>
                  {props.errorMessage}{" "}
                  <a href="mailto:support@tenkacloud.cloud">support@tenkacloud.cloud</a>
                </Alert>
              ) : null}

              {props.signingIn ? (
                <Box textAlign="center" padding="s">
                  <SpaceBetween direction="horizontal" size="s" alignItems="center">
                    <Spinner />
                    <span>{props.signingInLabel}</span>
                  </SpaceBetween>
                </Box>
              ) : (
                <Button
                  variant="primary"
                  iconAlign="right"
                  iconName="external"
                  onClick={() => {
                    void props.onSignIn();
                  }}
                  fullWidth
                >
                  {props.signInLabel}
                </Button>
              )}
            </SpaceBetween>
          </Container>
        </div>
      </main>

      <footer
        style={{
          padding: "20px 24px",
          borderTop: "1px solid #e4e7ec",
          background: "rgba(255, 255, 255, 0.65)",
          color: "#5d6877",
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>{t("login.footer_operator")}</span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <a
            href={LEGAL_LINKS.privacy}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#0969da", textDecoration: "none" }}
          >
            {t("login.footer_privacy")}
          </a>
          <a
            href={LEGAL_LINKS.terms}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#0969da", textDecoration: "none" }}
          >
            {t("login.footer_terms")}
          </a>
          <a
            href={LEGAL_LINKS.tokushoho}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#0969da", textDecoration: "none" }}
          >
            {t("login.footer_tokushoho")}
          </a>
        </span>
      </footer>
    </div>
  );
}
