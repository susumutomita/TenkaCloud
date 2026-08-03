/**
 * Issue #1329: System Admin (admin-console) のログイン画面。 LP と同じ branding を
 * 適用し、 「dev 感のある heading + 灰色 box」 から商用 SaaS のログイン画面へ refresh。
 *
 * Issue #1335 Phase 1: SAML SSO multi-IdP HRD picker を追加。
 *   1) SAML 未設定 (samlIdpDirectory が空): 旧 1-step flow (= 「サインイン」 button 押下で
 *      Cognito Hosted UI へ redirect、 そこで local Cognito sign-in)
 *   2) SAML 設定済 (= directory に 1 つ以上 provider):
 *      a) email 入力フォームを表示
 *      b) submit 時に `resolveIdp(email, directory)` で候補解決:
 *         - kind: "local"    → `beginLogin()` で local sign-in (Hosted UI に email 自動入力 NG だが、
 *                              fallback として local 経路を提供)
 *         - kind: "redirect" → `beginLogin({ identityProvider })` で IdP に直接 redirect
 *         - kind: "select"   → 候補 IdP の button 列を表示 (= 同一 domain 複数 IdP)
 *
 * Issue #1360: SAML 未設定の場合、 中間の 「サインイン」 button は無意味な 1 click を
 * 増やすだけだったため、 mount 直後に `beginLogin()` を発火させて Cognito Hosted UI に
 * 直接 redirect する。 SAML 設定済の場合は picker を出すために中間 page が必要なので
 * 既存 UX を維持する。
 *
 * [#2866] application-admin-console の Login.tsx と似るのは意図的 (plane ごとに独立した
 * SPA、 app boundary 優先で共有しない)。 共通部分は web-kit の ConsoleAuthShell に既に抽出済。
 */

import { ConsoleAuthShell } from "@tenkacloud/web-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { distinctProviders, type IdpResolution, resolveIdp } from "../auth/idp-resolution";
import {
  ArrowIcon,
  ConsoleLegalFoot,
  ProductLoginShell,
  systemConsoleCopy,
} from "../components/ProductLoginShell";
import type { AppConfig } from "../config";
import { type LocaleCode, useI18n, useT } from "../i18n";

export function LoginPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  // SAML 有効時に email 解決後 「複数候補」 で picker を出す状態。
  const [pickerProviders, setPickerProviders] = useState<readonly string[] | undefined>();

  const samlEnabled = useMemo(
    () => distinctProviders(config.samlIdpDirectory).length > 0,
    [config.samlIdpDirectory],
  );

  const startLogin = async (options?: { identityProvider?: string }) => {
    setSigningIn(true);
    setErrorMessage(undefined);
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

  // Issue #1360: SAML 未設定なら mount 直後に Cognito へ自動 redirect する (= 中間 click
  // を排除)。 React StrictMode 等の重複 mount で 2 度発火しないよう ref で guard。 error
  // 発生時は flag を維持し、 user が button で再試行する経路に倒す。 依存に startLogin を
  // 入れると毎 render で hook 再評価されるため samlEnabled のみに固定し、 重複発火は
  // autoStartedRef で 1 度に絞り込む。
  const autoStartedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above (#1360).
  useEffect(() => {
    if (samlEnabled) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startLogin();
  }, [samlEnabled]);

  // === SAML 未設定: 自動 redirect 中の spinner / error fallback を表示 ===
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

  // === SAML 設定済 ===
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
 * 1 個前提なので、 内部で同じ wordmark / footer / branding を流用しつつ form を組む。
 * shell の重複は将来 refactor で 1 つに統合する (本 PR では追加なし優先)。
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
