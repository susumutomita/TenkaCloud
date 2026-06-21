/**
 * System Admin (Control Plane) sign-in shell — design import "Control Plane Login.html".
 *
 * Presentation only: renders the shared `ConsoleAuthShell` (ink operator stage + form
 * panel + JA/EN toggle, web-kit) with `plane="system"`. The auth logic (Cognito Hosted
 * UI redirect, SAML routing) stays in `Login.tsx`; this shell only renders the step area
 * passed by it via these props.
 */

import { type ConsoleAuthCopy, ConsoleAuthShell } from "@tenkacloud/web-kit";
import { type LocaleCode, useI18n, useT } from "../i18n";

const LEGAL_LINKS = {
  privacy: "https://tenkacloud.cloud/privacy.html",
  terms: "https://tenkacloud.cloud/terms.html",
  tokushoho: "https://tenkacloud.cloud/legal.html",
} as const;

type Translate = (key: string) => string;

/** external-link glyph for the SSO button. */
export function ExtIcon() {
  return (
    <svg className="ext" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 5h5v5M19 5l-9 9M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** right-arrow glyph for the email / IdP-continue buttons. */
export function ArrowIcon() {
  return (
    <svg
      className="arrow"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Shared System-plane copy for the ConsoleAuthShell (title/subtitle come from props). */
export function systemConsoleCopy(t: Translate, title: string, subtitle: string): ConsoleAuthCopy {
  return {
    planeLabel: t("login.plane_label"),
    eyebrow: t("login.stage_eyebrow"),
    headlineLead: t("login.stage_h1_lead"),
    headlineEm: t("login.stage_h1_em"),
    lede: t("login.stage_lede"),
    kicker: t("login.kicker"),
    title,
    subtitle,
    footEvent: t("login.foot_event"),
  };
}

/** Operator + legal footer, shared by both step views. */
export function ConsoleLegalFoot({ t }: { t: Translate }) {
  return (
    <>
      <span>{t("login.footer_operator")}</span>
      <span className="links">
        <a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">
          {t("login.footer_privacy")}
        </a>
        <a href={LEGAL_LINKS.terms} target="_blank" rel="noreferrer">
          {t("login.footer_terms")}
        </a>
        <a href={LEGAL_LINKS.tokushoho} target="_blank" rel="noreferrer">
          {t("login.footer_tokushoho")}
        </a>
      </span>
    </>
  );
}

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
    <ConsoleAuthShell
      plane="system"
      copy={systemConsoleCopy(t, props.title, props.subtitle)}
      locale={locale}
      onLocale={(code) => setLocale(code as LocaleCode)}
      foot={<ConsoleLegalFoot t={t} />}
    >
      {props.errorMessage ? (
        <div className="error-line">
          <span className="x">!</span>
          {props.errorMessage}{" "}
          <a href="mailto:support@tenkacloud.cloud">support@tenkacloud.cloud</a>
        </div>
      ) : null}
      {props.signingIn ? (
        <div className="redirecting">
          <span className="spinner" />
          <span>{props.signingInLabel}</span>
        </div>
      ) : (
        <>
          <button type="button" className="sso" onClick={() => void props.onSignIn()}>
            {props.signInLabel}
            <ExtIcon />
          </button>
          <div className="note">
            <span className="ic">i</span>
            <p>
              <b>{t("login.note_lead")}</b> {t("login.note_body")}
            </p>
          </div>
        </>
      )}
    </ConsoleAuthShell>
  );
}
