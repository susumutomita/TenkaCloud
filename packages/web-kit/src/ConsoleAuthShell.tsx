import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import "./console-auth.css";

/**
 * Admin-console sign-in shell (design import: "Control Plane Login.html" /
 * "Application Plane Login.html", shared admin.jsx).
 *
 * Two-column layout shared by both admin consoles: an ink operator "stage" on the
 * left (brand + headline + a decorative status card) and a form panel on the right.
 * This component is **presentation only** — it renders the frame, the JA/EN toggle,
 * and a decorative opcard; the actual auth step area (SSO button / redirecting /
 * email / IdP picker) is passed as `children`, so each app keeps its own
 * Cognito + SAML wiring. The left "opcard" is decorative brand chrome (no real
 * tenant/event data exists on a pre-auth screen).
 */

export type ConsoleAuthPlane = "system" | "app";

export interface ConsoleAuthCopy {
  /** Pill next to the wordmark — "Control Plane" / "Application Plane". */
  readonly planeLabel: string;
  readonly eyebrow: string;
  /** Headline is two parts: a normal lead + a muted emphasis tail. */
  readonly headlineLead: string;
  readonly headlineEm: string;
  readonly lede: string;
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string;
  readonly footEvent: string;
}

export interface ConsoleAuthShellProps {
  readonly plane: ConsoleAuthPlane;
  readonly copy: ConsoleAuthCopy;
  readonly locale: string;
  readonly onLocale: (code: "ja" | "en") => void;
  /** Optional legal footer (operator + links), rendered under the step area. */
  readonly foot?: ReactNode;
  /** The auth step area (SSO / redirecting / email / picker). */
  readonly children: ReactNode;
}

// Decorative stage cards — fixed brand chrome, not the operator's live data.
const TENANTS = [
  { name: "acme-corp", sub: "Platinum", tone: "ok", st: "ACTIVE" },
  { name: "globex", sub: "Gold", tone: "info", st: "PROVISIONING" },
  { name: "initech", sub: "Gold", tone: "ok", st: "ACTIVE" },
  { name: "umbrella", sub: "Silver", tone: "warn", st: "SUSPENDED" },
] as const;
const COUNTERS = [
  { tone: "ok", n: "8", l: "COMPLETE" },
  { tone: "info", n: "1", l: "IN PROGRESS" },
  { tone: "err", n: "1", l: "FAILED" },
] as const;

function SystemOpcard() {
  return (
    <div className="opcard">
      <div className="head">
        <span>TENANTS</span>
        <span className="meta">12 active</span>
      </div>
      {TENANTS.map((r) => (
        <div className="row" key={r.name}>
          <span className="name">
            {r.name}
            <span className="sub">{r.sub}</span>
          </span>
          <span className={`sb ${r.tone}`}>
            <span className="d" />
            {r.st}
          </span>
        </div>
      ))}
    </div>
  );
}

function AppOpcard() {
  return (
    <div className="opcard">
      <div className="head">
        <span>OPEN ARENA · SEASON 01</span>
        <span className="sb ok" style={{ color: "rgba(255,255,255,0.8)" }}>
          <span className="d" />
          RUNNING
        </span>
      </div>
      <div className="row">
        <span className="name">
          16 teams<span className="sub">8 problems</span>
        </span>
        <span className="sb info">
          <span className="d" />
          DEPLOYING
        </span>
      </div>
      <div className="counters">
        {COUNTERS.map((c) => (
          <div className={`c ${c.tone}`} key={c.l}>
            <div className="n">{c.n}</div>
            <div className="l">
              <span className="d" />
              {c.l}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConsoleAuthShell({
  plane,
  copy,
  locale,
  onLocale,
  foot,
  children,
}: ConsoleAuthShellProps) {
  return (
    <div className="tc-console-auth">
      <div className="auth">
        <aside className="stage">
          <div className="brand">
            <BrandMark size={22} />
            <span>
              Tenka<span className="sub">Cloud</span>
            </span>
            <span className="plane">{copy.planeLabel}</span>
          </div>
          <div className="center">
            <div className="eyebrow">{copy.eyebrow}</div>
            <h1>
              <span>{copy.headlineLead}</span>
              <em>{copy.headlineEm}</em>
            </h1>
            <p className="lede">{copy.lede}</p>
            {plane === "system" ? <SystemOpcard /> : <AppOpcard />}
          </div>
          <div className="stage-foot">
            <span>{copy.footEvent}</span>
          </div>
        </aside>

        <main className="panel">
          <div className="topbar">
            <div className="lang">
              <button
                type="button"
                className={locale === "ja" ? "on" : ""}
                onClick={() => onLocale("ja")}
              >
                JA
              </button>
              <button
                type="button"
                className={locale === "en" ? "on" : ""}
                onClick={() => onLocale("en")}
              >
                EN
              </button>
            </div>
          </div>

          <div className="form-wrap">
            <div className="kicker">{copy.kicker}</div>
            <h2>{copy.title}</h2>
            <p className="subtitle">{copy.subtitle}</p>
            {children}
            {foot ? (
              <div className="foot" style={{ marginTop: 40 }}>
                {foot}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
