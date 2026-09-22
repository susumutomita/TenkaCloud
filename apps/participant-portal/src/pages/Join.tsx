import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  loadRegistration,
  type RegistrationInfo,
  type RegistrationProgress,
  registrationProgressSchema,
  registrationRequest,
  registrationStorage,
} from "../api/registration-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import "./Join.css";

const knownErrors = new Set([
  "not_found",
  "closed",
  "full",
  "conflict",
  "rate_limited",
  "registration_unavailable",
]);

export function JoinPage({ config }: { config: AppConfig }) {
  const { tenantId = "", eventId = "" } = useParams();
  return (
    <JoinSession
      key={`${tenantId}/${eventId}`}
      config={config}
      tenantId={tenantId}
      eventId={eventId}
    />
  );
}

function JoinSession({
  config,
  tenantId,
  eventId,
}: {
  config: AppConfig;
  tenantId: string;
  eventId: string;
}) {
  const t = useT();
  const auth = useAuth();
  const navigate = useNavigate();
  const storage = useMemo(() => registrationStorage(tenantId, eventId), [tenantId, eventId]);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [info, setInfo] = useState<RegistrationInfo | null>(null);
  const [progress, setProgress] = useState<RegistrationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const fail = useCallback(
    (cause: unknown) =>
      setError(
        cause instanceof Error && knownErrors.has(cause.message)
          ? cause.message
          : "registration_unavailable",
      ),
    [],
  );

  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setError("");
    if (config.mode !== "backend" || config.cloudMode === "local") {
      setError("unsupported");
      return;
    }
    void loadRegistration(config.apiBaseUrl, tenantId, eventId, request.signal)
      .then((value) => {
        if (request.signal.aborted) return;
        setInvitation(value.invitation);
        setInfo(value.info);
        setProgress(value.progress);
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) fail(cause);
      });
  }, [config.apiBaseUrl, config.mode, config.cloudMode, tenantId, eventId, fail]);

  useEffect(() => {
    refresh();
    return () => pending.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (progress?.state !== "preparing") return;
    const timer = window.setTimeout(refresh, 5000);
    return () => window.clearTimeout(timer);
  }, [progress, refresh]);

  async function claim() {
    if (!invitation || busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = storage.ensureReceipt();
      setProgress(
        await registrationRequest(
          config.apiBaseUrl,
          tenantId,
          eventId,
          "claim",
          invitation,
          registrationProgressSchema,
          receipt,
        ),
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!progress?.teamLoginKey || busy) return;
    setBusy(true);
    setError("");
    try {
      await auth.login(progress.teamLoginKey);
      navigate("/setup", { replace: true });
    } catch (cause) {
      fail(cause);
      setBusy(false);
    }
  }

  return (
    <main className="join-page">
      <div className="join-brand">TenkaCloud</div>
      <section className="join-card" aria-labelledby="join-title">
        <p className="join-eyebrow">{t("join.eyebrow")}</p>
        <h1 id="join-title">{progress?.eventName ?? info?.name ?? t("join.title")}</h1>
        <ol className="join-steps" aria-label={t("join.steps_label")}>
          {[t("join.step_1"), t("join.step_2"), t("join.step_3")].map((label, index) => (
            <li key={label}>
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {error && (
          <div role="alert" className="join-alert">
            {t(`join.error_${error}`)}
          </div>
        )}
        {!progress && info && (
          <>
            <p>{t("join.explanation")}</p>
            <p className="join-status">
              {t(`join.${info.state}`)}
              {info.state === "open" ? ` ${t("join.remaining", { count: info.remaining })}` : ""}
            </p>
            <button
              className="join-primary"
              type="button"
              disabled={info.state !== "open" || busy}
              onClick={() => void claim()}
            >
              {busy ? t("join.submitting") : t("join.claim")}
            </button>
          </>
        )}
        {progress && (
          <div aria-live="polite">
            <h2>{t(`join.state_${progress.state}`)}</h2>
            <p>{t(`join.help_${progress.state}`)}</p>
            <p>{t("join.progress", { ready: progress.ready, total: progress.total })}</p>
            {progress.state === "ready" && (
              <button
                type="button"
                className="join-primary"
                disabled={busy}
                onClick={() => void start()}
              >
                {t("join.start")}
              </button>
            )}
          </div>
        )}
        {!info && !progress && !error && <p role="status">{t("join.loading")}</p>}
        {(error || progress?.state === "failed" || progress?.state === "unprepared") && (
          <button type="button" className="join-secondary" disabled={busy} onClick={refresh}>
            {t("join.retry")}
          </button>
        )}
        <p className="join-footnote">{t("join.footnote")}</p>
      </section>
    </main>
  );
}
