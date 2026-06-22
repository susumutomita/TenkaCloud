import { BrandMark } from "@tenkacloud/web-kit";
import { useState } from "react";
import { useNavigate } from "react-router";
import { PortalAuthError, PortalValidationError, updateTeamName } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { type LocaleCode, useI18n } from "../i18n";
import "./TeamSetup.css";

/**
 * 競技者がログイン直後に通る team name 入力ページ (design import: "Team Name Setup.html")。
 *
 * sign-in 画面 (Login.css) と同じ Ink / Summit family のカスタムデザイン。 onboarding の
 * 3 ステップ rail + スコアボード preview を出しつつ、 実ロジックは従来どおり `PATCH /portal/me`
 * (= `updateTeamName`) でサーバ側 `displayTeamName` を設定し、 AuthProvider の session を更新して
 * `/` に戻る。
 *
 * Issue #1191: 既に teamName を設定済の競技者が dropdown 経由で開く edit mode では、 onboarding
 * 専用の chrome (eyebrow / rail / skip) を出さず、 edit 用の見出し + Cancel に切り替える。
 * dev-mock モードは AuthProvider が初期 session に `teamNameSetByCompetitor=true` を入れるため
 * 通常ここへは来ないが、 来た場合は backend を呼ばず session を直接更新する。
 */

const MAX = 40;
// letters, digits, half-width space, _ , - , Japanese (kana + CJK)。 sign-in と同じ語彙。
const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;
const TEAM_NAME_CHARSET_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]*$/;

interface TeamNameDraft {
  readonly trimmed: string;
  readonly invalid: boolean;
}

interface TeamNameSubmitState extends TeamNameDraft {
  readonly sessionToken?: string;
  readonly submitting: boolean;
}

export function describeTeamNameDraft(teamName: string): TeamNameDraft {
  const trimmed = teamName.trim();
  return {
    trimmed,
    invalid: teamName.length > 0 && !TEAM_NAME_RE.test(trimmed),
  };
}

export function canSubmitTeamName(state: TeamNameSubmitState): boolean {
  return !!state.sessionToken && state.trimmed.length > 0 && !state.invalid && !state.submitting;
}

export function formatTeamSetupSubmitError(err: unknown, validationMessage: string): string {
  if (err instanceof PortalValidationError) return validationMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** touched 後にだけ出す inline error の i18n key (空 / 長すぎ / 使えない文字)。 通れば null。 */
export function teamNameErrorKey(name: string): "err_empty" | "err_long" | "err_char" | null {
  if (name.trim().length === 0) return "err_empty";
  if (name.length > MAX) return "err_long";
  if (!TEAM_NAME_CHARSET_RE.test(name)) return "err_char";
  return null;
}

// preview のスコアボードは演出 chrome (= pre-join では実順位が無い)。 ロケール非依存の固定値。
const PREVIEW_ROWS = [
  { rank: 2, nm: "team-honnoji", pt: 7990 },
  { rank: 3, nm: "team-sekigahara", pt: 7710 },
];
const PREVIEW_YOU_PT = "8,420";

export function TeamSetupPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();
  const isMock = useIsMock();
  const isEditMode = auth.session?.teamNameSetByCompetitor === true;

  const [name, setName] = useState(isEditMode ? (auth.session?.teamName ?? "") : "");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = describeTeamNameDraft(name);
  const canSubmit = canSubmitTeamName({
    ...draft,
    sessionToken: auth.session?.sessionToken,
    submitting,
  });
  const errKey = touched ? teamNameErrorKey(name) : null;
  const inputClass = errKey ? "err" : touched && canSubmit ? "ok" : "";
  const near = name.length > MAX - 8;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    // submit は disabled={!canSubmit} なので canSubmit=false では呼ばれない。 canSubmit は
    // sessionToken を要求するので auth.session も非 null。 = 防御的な不到達分岐。
    /* v8 ignore next */
    if (!canSubmit || !auth.session) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isMock) {
        auth.updateSession({ teamName: draft.trimmed, teamNameSetByCompetitor: true });
        navigate("/");
        return;
      }
      const view = await updateTeamName(
        config.apiBaseUrl,
        auth.session.sessionToken,
        draft.trimmed,
      );
      auth.updateSession({
        teamName: view.team.teamName,
        teamNameSetByCompetitor: view.team.teamNameSetByCompetitor,
      });
      navigate("/");
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        navigate("/login");
        return;
      }
      setError(formatTeamSetupSubmitError(err, t("team_setup.validation_failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const eventLabel = config.eventTitle ?? "TenkaCloud Battle";

  return (
    <div className="tc-team-setup">
      <header className="topbar">
        <div className="brand">
          <BrandMark size={20} />
          <span>TenkaCloud</span>
          <span className="sep">—</span>
          <span className="event">{eventLabel}</span>
        </div>
        <div className="lang">
          {(["ja", "en"] as const).map((code: LocaleCode) => (
            <button
              type="button"
              key={code}
              className={locale === code ? "on" : ""}
              onClick={() => setLocale(code)}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {!isEditMode && (
        <div className="rail">
          <div className="inner">
            <span className="step done">
              <span className="dot">✓</span>
              <span className="t">{t("team_setup.step_signin")}</span>
            </span>
            <span className="line" />
            <span className="step active">
              <span className="dot">2</span>
              <span className="t">{t("team_setup.step_name")}</span>
            </span>
            <span className="line" />
            <span className="step">
              <span className="dot">3</span>
              <span className="t">{t("team_setup.step_start")}</span>
            </span>
          </div>
        </div>
      )}

      <div className="stage">
        <form className="card" onSubmit={handleSubmit} noValidate>
          {!isEditMode && (
            <div className="eyebrow">
              <span className="mk">
                <BrandMark size={14} />
              </span>
              {t("team_setup.eyebrow")}
            </div>
          )}
          <h1>{t(isEditMode ? "team_setup.edit_title" : "team_setup.title")}</h1>
          <p className="sub">
            {t(isEditMode ? "team_setup.edit_description" : "team_setup.description")}
          </p>

          {error && (
            <div className="error-line" role="alert" style={{ marginBottom: 18 }}>
              <span className="x">!</span>
              {error}
            </div>
          )}

          <div className="field">
            <span className="label">{t("team_setup.field_label")}</span>
            <p className="desc">{t("team_setup.field_description")}</p>
            <div className={`input ${inputClass}`}>
              <input
                type="text"
                value={name}
                // biome-ignore lint/a11y/noAutofocus: onboarding step で唯一の入力欄なので focus を当てる
                autoFocus
                maxLength={80}
                spellCheck={false}
                placeholder={t("team_setup.field_placeholder")}
                disabled={submitting}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!touched) setTouched(true);
                }}
                onBlur={() => setTouched(true)}
              />
              <span className={`count ${near ? "warn" : ""}`}>
                {name.length}/{MAX}
              </span>
            </div>
            <div className="meta">
              {errKey ? (
                <div className="error-line">
                  <span className="x">!</span>
                  {t(`team_setup.${errKey}`)}
                </div>
              ) : (
                <div className="rules">{t("team_setup.field_constraint")}</div>
              )}
            </div>
          </div>

          <div className="preview">
            <div className="ttl">
              <span className="d" />
              {t("team_setup.preview_title")}
            </div>
            <div className="board">
              <div className="row you">
                <span className="rank">1</span>
                <span className="nm">
                  {draft.trimmed ? (
                    <>
                      {draft.trimmed}
                      <span className="tag">{t("team_setup.you")}</span>
                    </>
                  ) : (
                    <span className="ph">{t("team_setup.placeholder_name")}</span>
                  )}
                </span>
                <span className="pt">{PREVIEW_YOU_PT}</span>
              </div>
              {PREVIEW_ROWS.map((r) => (
                <div className="row" key={r.nm}>
                  <span className="rank">{r.rank}</span>
                  <span className="nm">{r.nm}</span>
                  <span className="pt">{r.pt.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="submit" type="submit" disabled={!canSubmit}>
              {submitting ? <span className="spinner" /> : null}
              {submitting
                ? ""
                : t(isEditMode ? "team_setup.edit_submit_button" : "team_setup.submit_button")}
            </button>
            {isEditMode && (
              <button
                className="skip"
                type="button"
                disabled={submitting}
                onClick={() => navigate("/")}
              >
                {t("team_setup.cancel_button")}
              </button>
            )}
          </div>

          <div className="changelater">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 12a8 8 0 0 1-13.7 5.6L4 16"
                stroke="#86868b"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M20 4v4h-4M4 20v-4h4"
                stroke="#86868b"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {t("team_setup.changelater")}
          </div>
        </form>
      </div>
    </div>
  );
}
