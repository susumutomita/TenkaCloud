/**
 * Issue #3226: sign-in for the local competition host (`bun start`).
 *
 * The organizer types the host key printed in the terminal; the host exchanges it for a
 * short-lived session token held only in memory by the shared AuthProvider. There is no
 * Cognito redirect, no stored credential and no demo/practice fallback: a wrong key is shown
 * as a wrong key.
 */

import type { TokenSet } from "@tenkacloud/auth-client";
import { ConsoleAuthShell } from "@tenkacloud/web-kit";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ArrowIcon, applicationConsoleCopy } from "../components/ProductLoginShell";
import type { AppConfig } from "../config";
import { type LocaleCode, useI18n, useT } from "../i18n";

type SessionResponse = Partial<TokenSet> & { message?: unknown };

function isSession(value: SessionResponse): value is TokenSet & { refreshToken: string } {
  return (
    typeof value.idToken === "string" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number"
  );
}

/** `POST /api/host/login`: the terminal's host key for a short-lived, memory-only session. */
async function exchangeHostKey(
  apiBaseUrl: string,
  key: string,
  t: (key: string) => string,
): Promise<TokenSet> {
  const response = await fetch(`${apiBaseUrl}/host/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const value = (await response.json()) as SessionResponse;
  if (response.status === 401) throw new Error(t("local_host.login_invalid_key"));
  if (!response.ok || !isSession(value))
    throw new Error(
      typeof value.message === "string" ? value.message : t("local_host.login_failed"),
    );
  return {
    idToken: value.idToken,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
  };
}

export function LocalHostLoginPage({
  config,
  returnPath,
}: {
  readonly config: AppConfig;
  readonly returnPath?: string;
}) {
  const auth = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (auth.tokens) return <Navigate to={returnPath ?? "/events"} replace />;

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key) return;
    setBusy(true);
    setError(undefined);
    try {
      auth.setTokens(await exchangeHostKey(config.apiBaseUrl, key, t));
      setKey("");
      navigate(returnPath ?? "/events", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("local_host.login_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsoleAuthShell
      plane="app"
      copy={applicationConsoleCopy(t, t("local_host.login_title"), t("local_host.login_subtitle"))}
      locale={locale}
      onLocale={(code) => setLocale(code as LocaleCode)}
    >
      {error ? (
        <div className="error-line" role="alert">
          <span className="x">!</span>
          {error}
        </div>
      ) : null}
      <form onSubmit={(event) => void signIn(event)} noValidate>
        <div className="field">
          <label className="label" htmlFor="local-host-key">
            {t("local_host.login_key_label")}
          </label>
          <div className="input">
            <input
              id="local-host-key"
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="sso" disabled={busy || !key}>
          {busy ? t("local_host.login_signing_in") : t("local_host.login_submit")}
          <ArrowIcon />
        </button>
      </form>
    </ConsoleAuthShell>
  );
}
