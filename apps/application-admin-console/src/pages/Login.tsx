/**
 * Issue #1329: Tenant Admin (application-admin-console) のログイン画面。 LP と同じ
 * branding を適用し、 「Application Admin Console」 + dev jargon の文言を商用 SaaS
 * のログイン画面へ refresh。
 *
 * Issue #1340 Phase 2 + #1360 統合:
 *   - SAML 未設定 (samlIdpDirectory が空):
 *       mount 直後に `beginLogin()` を発火させて Cognito Hosted UI に直接 redirect する
 *       (#1360)。中間 「サインイン」 button は冗長な 1 click でしかない。
 *   - SAML 設定済 (= directory に 1 つ以上 provider, #1340 Phase 2):
 *       a) email 入力フォームを表示
 *       b) submit 時に `resolveIdp(email, directory)` で候補解決:
 *          - kind: "local"    → `beginLogin()` で local sign-in (= fallback)
 *          - kind: "redirect" → `beginLogin({ identityProvider })` で IdP に直接 redirect
 *          - kind: "select"   → 候補 IdP の button 列を表示 (= 同一 domain 複数 IdP)
 *
 * 表示状態:
 *   1) signing  : Cognito へ redirect 中 spinner (= SAML 未設定時の初期状態)
 *   2) idle     : title + subtitle + email 入力 (= SAML 設定済時の初期状態)
 *   3) error    : beginLogin throw 時の fallback alert + mailto link
 *                 (= button を再表示し再 sign-in 試行を許可)
 *
 * [#2866] admin-console の Login.tsx と似るのは意図的 (plane ごとに独立した SPA、
 * app boundary 優先で共有しない)。 共通部分は web-kit の ConsoleAuthShell に既に抽出済。
 */

import { ConsoleAuthShell } from "@tenkacloud/web-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { distinctProviders, type IdpResolution, resolveIdp } from "../auth/idp-resolution";
import { rememberLoginReturnPath } from "../auth/login-return-path";
import {
  ArrowIcon,
  applicationConsoleCopy,
  ConsoleLegalFoot,
  ProductLoginShell,
} from "../components/ProductLoginShell";
import type { AppConfig } from "../config";
import { type LocaleCode, useI18n, useT } from "../i18n";

export function LoginPage({ config, returnPath }: { config: AppConfig; returnPath?: string }) {
  const auth = useAuth();
  const t = useT();
  // mount 直後に auto-redirect を 1 回だけ走らせる guard (#1360)。 React StrictMode の 2 度
  // mount / re-render での重複発火を防ぐ。 error 発生時は user 操作で再試行できるよう
  // この flag は触らず、 button の onSignIn から再度 `startLogin` を呼ぶ経路に倒す。
  const autoStartedRef = useRef(false);
  const samlEnabled = useMemo(
    () => distinctProviders(config.samlIdpDirectory).length > 0,
    [config.samlIdpDirectory],
  );
  // SAML 未設定時は mount 直後に redirect → signing の初期 true で spinner を出す。
  // SAML 設定済時は email 入力を待つので idle 初期 false。
  const [signingIn, setSigningIn] = useState(!samlEnabled);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  // SAML 有効時に email 解決後 「複数候補」 で picker を出す状態。
  const [pickerProviders, setPickerProviders] = useState<readonly string[] | undefined>();

  const startLogin = async (options?: { identityProvider?: string }) => {
    setSigningIn(true);
    setErrorMessage(undefined);
    rememberLoginReturnPath(returnPath);
    try {
      await auth.login(options);
      // 成功時は Cognito Hosted UI への redirect が走るため、 ここに到達しない (= browser
      // が unload される)。 finally の setSigningIn(false) を打つと redirect 直前に
      // button が一瞬戻ってしまう UX 劣化があるため、 成功 path では state を保持。
    } catch (err) {
      setSigningIn(false);
      setErrorMessage(
        `${t("login.error_body")} ${err instanceof Error ? err.message : ""} ${t(
          "login.support_contact",
        )}`,
      );
    }
  };

  // SAML 候補なし → mount 即 Cognito へ (#1360)。 error からの再試行は button で。
  // signIn を依存に入れると毎 render で hook 再評価されるため空 array に固定し、 重複発火は
  // autoStartedRef で 1 度に絞り込む。
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above (#1360).
  useEffect(() => {
    if (samlEnabled) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startLogin();
  }, []);

  // === SAML 未設定: #1360 auto-redirect flow (mount 時に startLogin が走る) ===
  if (!samlEnabled) {
    return (
      <ProductLoginShell
        title={t("login.title")}
        subtitle={t("login.subtitle")}
        signInLabel={t("login.sign_in_button")}
        signingInLabel={t("login.signing_in")}
        signingIn={signingIn}
        errorMessage={errorMessage}
        onSignIn={() => startLogin()}
      />
    );
  }

  // === SAML 設定済 (#1340 Phase 2) ===
  // email を入力 → resolveIdp で振り分け。 1 件 redirect / 複数 picker / 0 件 local。
  const onSubmitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    const decision: IdpResolution = resolveIdp(trimmed, config.samlIdpDirectory);
    if (decision.kind === "local") {
      await startLogin();
      return;
    }
    if (decision.kind === "redirect") {
      await startLogin({ identityProvider: decision.provider });
      return;
    }
    // kind: "select" — 候補 IdP の button 列を出す。
    setPickerProviders(decision.providers);
  };

  return (
    <ProductLoginShellSaml
      title={t("login.title")}
      subtitle={t("login.subtitle")}
      signingIn={signingIn}
      errorMessage={errorMessage}
      email={email}
      onEmailChange={setEmail}
      onSubmitEmail={onSubmitEmail}
      pickerProviders={pickerProviders}
      onPick={(provider) => startLogin({ identityProvider: provider })}
      onCancelPicker={() => setPickerProviders(undefined)}
    />
  );
}

/**
 * SAML 有効時に表示する email→IdP 解決つき login UI。 既存 `ProductLoginShell` は SSO ボタン
 * 1 個前提なので、内部で同じ wordmark / footer / branding を流用しつつ form を組む。
 * admin-console/src/pages/Login.tsx の同名 component と branding を揃える。
 */
function ProductLoginShellSaml(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly signingIn: boolean;
  readonly errorMessage?: string;
  readonly email: string;
  readonly onEmailChange: (value: string) => void;
  readonly onSubmitEmail: (e: React.FormEvent) => void | Promise<void>;
  readonly pickerProviders?: readonly string[];
  readonly onPick: (provider: string) => void;
  readonly onCancelPicker: () => void;
}) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  return (
    <ConsoleAuthShell
      plane="app"
      copy={applicationConsoleCopy(t, props.title, props.subtitle)}
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
      {props.pickerProviders ? (
        <div>
          <p className="subtitle">{t("login.saml_pick_idp")}</p>
          <div className="idp-list">
            {props.pickerProviders.map((p) => (
              <button
                type="button"
                className="idp"
                key={p}
                disabled={props.signingIn}
                onClick={() => props.onPick(p)}
              >
                <span className="logo">{p.slice(0, 1).toUpperCase()}</span>
                <span className="meta">
                  <span className="n">{p}</span>
                </span>
                <ArrowIcon />
              </button>
            ))}
          </div>
          <button type="button" className="back" onClick={props.onCancelPicker}>
            ← {t("login.saml_back_to_email")}
          </button>
        </div>
      ) : (
        <form onSubmit={props.onSubmitEmail} noValidate>
          <div className="field">
            <label className="label" htmlFor="console-saml-email">
              {t("login.saml_email_label")}
            </label>
            <div className="input">
              <input
                id="console-saml-email"
                type="email"
                value={props.email}
                autoComplete="email"
                spellCheck={false}
                placeholder={t("login.email_placeholder")}
                disabled={props.signingIn}
                onChange={(e) => props.onEmailChange(e.target.value)}
              />
            </div>
          </div>
          <button type="submit" className="sso" disabled={props.signingIn}>
            {t("login.continue_label")}
            <ArrowIcon />
          </button>
        </form>
      )}
    </ConsoleAuthShell>
  );
}
