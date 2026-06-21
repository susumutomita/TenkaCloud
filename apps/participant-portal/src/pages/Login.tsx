import { BrandMark } from "@tenkacloud/web-kit";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { type LocaleCode, useI18n } from "../i18n";
import { clearInviteHash, readInviteKeyFromHash } from "../lib/invite";
import "./Login.css";

/**
 * 競技者サインイン画面 (design import: "Login Screen.html")。
 *
 * 左: ink の brand stage (Summit mark + 見出し + 装飾的な live leaderboard chrome)。
 * 右: チームログインキー入力フォーム。 backend (現状 mock) が session を発行する。
 *
 * design mock の `setTimeout` モックは使わず、 実際の `auth.login` に配線する。 成功時は
 * 「サインインしました / 環境を読み込み中」 の success 画面を一瞬見せてから home へ遷移する
 * (= 実際にサインイン済みで home route が load 中、 という正直な transition)。
 *
 * 既存 session がある状態で /login に来た場合は無条件で / へ redirect (Issue #496)。
 * 招待リンク (`/login#invite=<key>`) は key を prefill するが auto-submit はしない (#1772)。
 */

type Translate = (key: string) => string;

// brand stage の装飾 chrome (= pre-auth では実データが無いため、 ロケール非依存の演出値)。
const STAGE_EVENT_FALLBACK = "Open Arena";
const LIVE_TITLE = "SECURITY BATTLE ROYALE";
const LIVE_LABEL = "LIVE";
const DONE_REDIRECT_MS = 800;

/** auth.login の throw を表示用文字列へ翻訳する (= 既知エラーコードは i18n、 他は素通し)。 */
export function translateAuthError(err: unknown, t: Translate): string {
  const raw = err instanceof Error ? err.message : t("login.failed_generic");
  if (raw === "EMPTY_TEAM_LOGIN_KEY") return t("home.auth_error_empty_key");
  if (raw === "BACKEND_UNREACHABLE") return t("home.auth_error_backend");
  return raw;
}

/** 装飾的な live leaderboard。 実イベントの順位ではなく、 arena の雰囲気を出す brand chrome。 */
function LiveBoard() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1600);
    return () => clearInterval(id);
  }, []);
  const base = [
    { name: "team-shogun", pts: 8420 },
    { name: "team-honnoji", pts: 7990 },
    { name: "team-sekigahara", pts: 7710 },
  ];
  return (
    <>
      {base.map((r, i) => (
        <div className={`row ${i === 0 ? "lead" : ""}`} key={r.name}>
          <span className="rank">{i + 1}</span>
          <span className="name">{r.name}</span>
          <span className="pts">{(r.pts + tick * (3 - i) * 7).toLocaleString()}</span>
        </div>
      ))}
    </>
  );
}

function BrandStage({ t, eventLabel }: { t: Translate; eventLabel: string }) {
  return (
    <aside className="stage">
      <div className="brand">
        <BrandMark size={22} />
        <span>
          Tenka<span className="sub">Cloud</span>
        </span>
      </div>
      <div className="center">
        <div className="eyebrow">{t("login.stage_eyebrow")}</div>
        <h1>
          <span>{t("login.stage_h1_a")}</span>
          <em>{t("login.stage_h1_em")}</em>
        </h1>
        <p className="lede">{t("login.stage_lede")}</p>
        <div className="live-card">
          <div className="head">
            <span>{LIVE_TITLE}</span>
            <span className="live">
              <span className="d" />
              {LIVE_LABEL}
            </span>
          </div>
          <LiveBoard />
        </div>
      </div>
      <div className="stage-foot">
        <span>{eventLabel}</span>
      </div>
    </aside>
  );
}

function DonePanel({
  t,
  teamKey,
  onReset,
}: {
  t: Translate;
  teamKey: string;
  onReset: () => void;
}) {
  return (
    <div className="done">
      <div className="check">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 13l4 4L19 7"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2>{t("login.done_h")}</h2>
      <p>{t("login.done_p")}</p>
      <div className="team">{teamKey}</div>
      <div>
        <button type="button" className="again" onClick={onReset}>
          {t("login.again")}
        </button>
      </div>
    </div>
  );
}

interface SignInFormProps {
  readonly t: Translate;
  readonly isMock: boolean;
  readonly eventLabel: string;
  readonly teamLoginKey: string;
  readonly show: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onToggleShow: () => void;
  readonly onChangeKey: (value: string) => void;
  readonly onSubmit: (e: React.FormEvent) => void;
}

function SignInForm(props: SignInFormProps) {
  const { t, isMock, eventLabel, teamLoginKey, show, submitting, error, inputRef } = props;
  const canSubmit = teamLoginKey.trim().length > 0 && !submitting;
  return (
    <form className="form-wrap" onSubmit={props.onSubmit} noValidate>
      <div className="kicker">{t("login.kicker")}</div>
      <h2>{t("login.submit")}</h2>
      <p className="event">
        <span className="pin" />
        {eventLabel}
      </p>

      <div className="note">
        <span className="ic">i</span>
        <p>
          <b>{isMock ? t("login.mock_info_header") : t("login.note_lead")}</b>{" "}
          {isMock ? t("login.mock_info_body") : t("login.note_body")}
        </p>
      </div>

      <div className="field">
        <div className="label">
          <span className="name">{t("login.field_label")}</span>
          <button type="button" className="reveal" onClick={props.onToggleShow}>
            {show ? t("login.hide") : t("login.reveal")}
          </button>
        </div>
        <div className={error ? "input err" : "input"}>
          <input
            ref={inputRef}
            type={show || isMock ? "text" : "password"}
            value={teamLoginKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={isMock ? t("login.mock_field_placeholder") : t("login.field_placeholder")}
            disabled={submitting}
            onChange={(e) => props.onChangeKey(e.target.value)}
          />
        </div>
        {error ? (
          <div className="error-line">
            <span className="x">!</span>
            {error}
          </div>
        ) : (
          <div className="desc">
            {isMock ? t("login.mock_field_description") : t("login.field_desc")}
          </div>
        )}
      </div>

      <button className="submit" type="submit" disabled={!canSubmit}>
        {submitting ? <span className="spinner" /> : t("login.submit")}
      </button>

      <p className="helper">
        {t("login.helper_lead")}{" "}
        <button type="button" className="helper-link">
          {t("login.helper_link")}
        </button>
      </p>
    </form>
  );
}

export function LoginPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();
  const isMock = useIsMock();

  const [teamLoginKey, setTeamLoginKey] = useState(
    () => readInviteKeyFromHash(window.location.hash) ?? "",
  );
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 読み取り後は fragment を落とし、 login key をアドレスバー / 履歴に残さない。
  useEffect(() => {
    clearInviteHash();
  }, []);

  // success 画面を見せたあと home へ遷移する (= 実サインイン済みの transition)。 reset で取り消せる。
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => navigate("/"), DONE_REDIRECT_MS);
    return () => clearTimeout(id);
  }, [done, navigate]);

  // 既ログイン状態で /login に来た場合は home に redirect (= 別 key 黙々上書き防止)。
  if (auth.ready && auth.session) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (teamLoginKey.trim().length === 0) {
      setError(t("login.err_empty"));
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(teamLoginKey);
      setDone(true);
    } catch (err) {
      setError(translateAuthError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setDone(false);
    setTeamLoginKey("");
    setError(null);
  };

  const onChangeKey = (value: string) => {
    setTeamLoginKey(value);
    if (error) setError(null);
  };

  const eventLabel = config.eventTitle ?? STAGE_EVENT_FALLBACK;

  return (
    <div className="tc-login">
      <div className="auth">
        <BrandStage t={t} eventLabel={eventLabel} />
        <main className="panel">
          <div className="topbar">
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
          </div>

          {done ? (
            <DonePanel t={t} teamKey={teamLoginKey.trim()} onReset={reset} />
          ) : (
            <SignInForm
              t={t}
              isMock={isMock}
              eventLabel={eventLabel}
              teamLoginKey={teamLoginKey}
              show={show}
              submitting={submitting}
              error={error}
              inputRef={inputRef}
              onToggleShow={() => setShow((s) => !s)}
              onChangeKey={onChangeKey}
              onSubmit={onSubmit}
            />
          )}

          <div className="legal">{t("login.legal")}</div>
        </main>
      </div>
    </div>
  );
}
