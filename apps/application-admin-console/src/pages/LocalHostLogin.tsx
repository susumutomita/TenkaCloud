import type { TokenSet } from "@tenkacloud/auth-client";
import { ConsoleAuthShell, toErrorMessage } from "@tenkacloud/web-kit";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ArrowIcon, applicationConsoleCopy } from "../components/ProductLoginShell";
import type { AppConfig } from "../config";
import { type LocaleCode, useI18n, useT } from "../i18n";

const SAML_BROWSER_PROOF = "tenkacloud.saml.browser-proof";

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
  const [bootstrap, setBootstrap] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [samlEnabled, setSamlEnabled] = useState(false);
  const pendingSaml = useRef<Promise<TokenSet> | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(`${config.apiBaseUrl}/host/bootstrap-status`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Host status unavailable.");
        return (await response.json()) as { bootstrapCompleted: boolean };
      })
      .then((body) => {
        if (!cancelled) setBootstrap(!body.bootstrapCompleted);
      })
      .catch(() => {
        if (!cancelled) setError("Host status unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl]);

  useEffect(() => {
    let active = true;
    fetch(`${config.apiBaseUrl}/host/saml`)
      .then(async (response) => {
        if (!response.ok) throw new Error("SAML status unavailable.");
        return (await response.json()) as { enabled: boolean };
      })
      .then((status) => {
        if (active) setSamlEnabled(status.enabled === true);
      })
      .catch(() => {
        if (active)
          setError(
            locale === "ja" ? "SAML の設定を確認できません。" : "SAML status is unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [config.apiBaseUrl, locale]);

  useEffect(() => {
    let active = true;
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get("samlTicket");
    if (ticket && !pendingSaml.current) {
      const browserProof = sessionStorage.getItem(SAML_BROWSER_PROOF);
      sessionStorage.removeItem(SAML_BROWSER_PROOF);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      if (!browserProof) {
        setError(
          locale === "ja"
            ? "このブラウザから SAML ログインをやり直してください。"
            : "Start SAML sign-in again from this browser.",
        );
        return;
      }
      pendingSaml.current = exchangeCredentials(config.apiBaseUrl, "/host/saml/complete", {
        ticket,
        browserProof,
      });
    }
    if (pendingSaml.current) {
      setBusy(true);
      void pendingSaml.current
        .then((tokens) => {
          if (!active) return;
          pendingSaml.current = null;
          auth.setTokens(tokens);
          navigate(returnPath ?? "/events", { replace: true });
        })
        .catch((cause) => {
          if (active) {
            pendingSaml.current = null;
            setError(toErrorMessage(cause));
          }
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => {
      active = false;
    };
  }, [config.apiBaseUrl, auth.setTokens, navigate, returnPath, locale]);

  const signInWithSaml = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const browserProof = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      sessionStorage.setItem(SAML_BROWSER_PROOF, browserProof);
      const response = await fetch(`${config.apiBaseUrl}/host/saml/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ browserProof }),
      });
      const body = (await response.json()) as { url?: unknown; message?: unknown };
      if (!response.ok || typeof body.url !== "string")
        throw new Error(
          typeof body.message === "string" ? body.message : "SAML sign-in is unavailable.",
        );
      window.location.assign(body.url);
    } catch (cause) {
      sessionStorage.removeItem(SAML_BROWSER_PROOF);
      setError(toErrorMessage(cause));
      setBusy(false);
    }
  };

  if (auth.tokens) return <Navigate to={returnPath ?? "/events"} replace />;

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (bootstrap === null || !username || !password || (bootstrap && !key)) return;
    setBusy(true);
    setError(undefined);
    try {
      const tokens = await exchangeCredentials(
        config.apiBaseUrl,
        bootstrap ? "/host/bootstrap" : "/host/login",
        bootstrap ? { key, username, password } : { username, password },
      );
      auth.setTokens(tokens);
      setKey("");
      setPassword("");
      navigate(returnPath ?? "/events", { replace: true });
    } catch (cause) {
      setPassword("");
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitLabel = bootstrap ? t("local_host.bootstrap_submit") : t("local_host.login_submit");
  return (
    <ConsoleAuthShell
      plane="app"
      copy={applicationConsoleCopy(
        t,
        bootstrap ? t("local_host.bootstrap_title") : t("local_host.login_title"),
        bootstrap ? t("local_host.bootstrap_subtitle") : t("local_host.password_login_subtitle"),
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
      {samlEnabled && bootstrap === false && (
        <button type="button" className="sso" disabled={busy} onClick={() => void signInWithSaml()}>
          {locale === "ja" ? "SAML でログイン" : "Sign in with SAML"}
          <ArrowIcon />
        </button>
      )}
      {bootstrap !== null && (
        <form onSubmit={(event) => void signIn(event)} noValidate>
          {bootstrap && (
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
                  disabled={busy}
                  onChange={(event) => setKey(event.target.value)}
                />
              </div>
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor="organizer-username">
              {t("local_host.username_label")}
            </label>
            <div className="input">
              <input
                id="organizer-username"
                value={username}
                autoComplete="username"
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="organizer-password">
              {t("local_host.password_label")}
            </label>
            <div className="input">
              <input
                id="organizer-password"
                type="password"
                value={password}
                autoComplete={bootstrap ? "new-password" : "current-password"}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className="sso"
            disabled={busy || !username || !password || (bootstrap && !key)}
          >
            {busy ? t("local_host.login_signing_in") : submitLabel}
            <ArrowIcon />
          </button>
        </form>
      )}
    </ConsoleAuthShell>
  );
}
