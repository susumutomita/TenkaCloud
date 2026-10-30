import type { TokenSet } from "@tenkacloud/auth-client";
import { ConsoleAuthShell, toErrorMessage } from "@tenkacloud/web-kit";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { clearLocalHostSession, loadLocalHostSession } from "../auth/local-host-session";
import { ArrowIcon, applicationConsoleCopy } from "../components/ProductLoginShell";
import { type AppConfig, isLocalHost } from "../config";
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

async function exchangeCredentials(
  apiBaseUrl: string,
  path: string,
  body: unknown,
): Promise<TokenSet> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("Host sign-in failed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Host sign-in failed.");
  const value = parsed as SessionResponse;
  if (!response.ok || !isSession(value))
    throw new Error(typeof value.message === "string" ? value.message : "Host sign-in failed.");
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
  // A reload keeps this tab's session; confirm it with the host before trusting it.
  const [saved, setSaved] = useState(() => loadLocalHostSession());
  const { tokens, setTokens } = auth;
  useEffect(() => {
    if (!saved || tokens) return;
    let active = true;
    void fetch(`${config.apiBaseUrl}/host/me`, {
      headers: { authorization: `Bearer ${saved.idToken}` },
    })
      .then((response) => {
        if (!active) return;
        if (response.ok) {
          setTokens(saved);
          return;
        }
        clearLocalHostSession();
        setSaved(null);
      })
      .catch(() => {
        if (active) setSaved(null);
      });
    return () => {
      active = false;
    };
  }, [config.apiBaseUrl, saved, setTokens, tokens]);

  if (tokens) return <Navigate to={returnPath ?? "/events"} replace />;
  if (saved) return null;

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !key) return;
    setBusy(true);
    setError(undefined);
    // Keep the organizer key only for this request, including failed attempts.
    setKey("");
    try {
      const tokens = await exchangeCredentials(config.apiBaseUrl, "/host/login", { key });
      auth.setTokens(tokens);
      navigate(returnPath ?? "/events", { replace: true });
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsoleAuthShell
      plane="app"
      copy={applicationConsoleCopy(
        t,
        t("local_host.login_title"),
        t("local_host.login_subtitle"),
        isLocalHost(config),
      )}
      locale={locale}
      onLocale={(code) => setLocale(code as LocaleCode)}
    >
      {error && (
        <div className="error-line" role="alert">
          <span className="x">!</span>
          {error}
        </div>
      )}
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
              aria-describedby="local-host-key-reset"
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="sso" disabled={busy || !key}>
          {busy ? t("local_host.login_signing_in") : t("local_host.login_submit")}
          <ArrowIcon />
        </button>
        <div className="note">
          <span className="ic">i</span>
          <p id="local-host-key-reset">
            <b>{t("local_host.login_reset_lead")}</b> {t("local_host.login_reset_body")}
          </p>
        </div>
      </form>
    </ConsoleAuthShell>
  );
}
