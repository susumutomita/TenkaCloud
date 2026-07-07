import type { Locale } from "@/lib/i18n";

// Decorative product mockups ported from the legacy landing (landing/index.html).
// They reproduce the old marketing design's signature "screenshot" visuals — the
// hero dashboard, the Battle score-events panel, the Challenge quests panel, and the
// SSO credentials panel. They are presentation-only chrome (no live data, no links),
// bilingual so the JA "/" and EN "/en/" mirrors read the same, and purely decorative
// (aria-hidden). No product copy lives here — the marketing copy stays in site-copy.ts.

interface PreviewProps {
  readonly locale: Locale;
}

// ── Hero dashboard (the app-window on the right of the hero) ─────────────────────
const HERO_LABELS: Record<Locale, Record<string, string>> = {
  ja: {
    lang: "◉ 日本語 ▼",
    profile: "♙ ゲスト ▼",
    menu: "メニュー",
    event: "• イベント",
    home: "ホーム",
    scoreboard: "スコアボード",
    scoreEvents: "スコアイベント",
    notifications: "お知らせ",
    problems: "問題一覧",
    tools: "• ツール",
    sso: "SSO 資格情報",
    welcome: "ようこそ、ゲストさん",
    welcomeSub: "TenkaCloud Battle へようこそ",
    teamScore: "チーム累計スコア",
    total: "合計",
    rank: "順位",
    problemCount: "問題数",
    completed: "完了済",
    scoreTrend: "スコア推移",
    scoreTrendDesc: "同 event 内の全 2 チームを表示",
    selectTeam: "event / チームを選択　⌄",
    chartYou: "(ゲスト あなた) 2360 pt",
    legendYou: "━ (ゲスト あなた)",
    challengeTitle: "問題に挑戦",
    challengeBody: "3 問が deploy 済です。問題一覧から挑戦してください。",
    openProblems: "問題一覧を開く",
  },
  en: {
    lang: "◉ English ▼",
    profile: "♙ Guest ▼",
    menu: "Menu",
    event: "• Event",
    home: "Home",
    scoreboard: "Scoreboard",
    scoreEvents: "Score events",
    notifications: "Notifications",
    problems: "Problems",
    tools: "• Tools",
    sso: "SSO Credentials",
    welcome: "Welcome, Guest",
    welcomeSub: "Welcome to TenkaCloud Battle",
    teamScore: "Team cumulative score",
    total: "Total",
    rank: "Rank",
    problemCount: "Problems",
    completed: "Completed",
    scoreTrend: "Score trend",
    scoreTrendDesc: "Showing all 2 teams in this event",
    selectTeam: "Select event / team　⌄",
    chartYou: "(Guest you) 2360 pt",
    legendYou: "━ (Guest you)",
    challengeTitle: "Take on problems",
    challengeBody: "3 problems are deployed. Open the problem list to start.",
    openProblems: "Open problem list",
  },
};

export function HeroDashboard({ locale }: PreviewProps) {
  const t = HERO_LABELS[locale];
  return (
    <div className="app-window" aria-hidden="true">
      <div className="app-topbar">
        <span>TenkaCloud — TenkaCloud Battle</span>
        <span className="app-chrome-meta">
          <span>{t.lang}</span>
          <span>◎ Score: 2360 pt / Rank: 1/2</span>
          <span>{t.profile}</span>
        </span>
      </div>
      <div className="app-body">
        <aside className="app-sidebar">
          <div className="app-menu-title">
            <span>{t.menu}</span>
            <span>⌄</span>
          </div>
          <div className="app-menu-group">{t.event}</div>
          <span className="app-link on">{t.home}</span>
          <span className="app-link">{t.scoreboard}</span>
          <span className="app-link">{t.scoreEvents}</span>
          <span className="app-link">{t.notifications}</span>
          <div className="app-menu-group">• Quests</div>
          <span className="app-link">{t.problems}</span>
          <div className="app-menu-group">{t.tools}</div>
          <span className="app-link">{t.sso}</span>
        </aside>
        <div className="dashboard">
          <h3>{t.welcome}</h3>
          <div className="dashboard-sub">{t.welcomeSub}</div>
          <div className="metric-card">
            <div className="metric-title">{t.teamScore}</div>
            <div className="metric-grid">
              <div>
                <div className="metric-label">{t.total}</div>
                <div className="metric-value green">2360 pt</div>
              </div>
              <div>
                <div className="metric-label">{t.rank}</div>
                <div className="metric-value blue">1 / 2</div>
              </div>
              <div>
                <div className="metric-label">{t.problemCount}</div>
                <div className="metric-value">3</div>
              </div>
              <div>
                <div className="metric-label">{t.completed}</div>
                <div className="metric-value">1</div>
              </div>
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t.scoreTrend}</div>
                <div className="chart-desc">{t.scoreTrendDesc}</div>
              </div>
              <div className="select-pill">{t.selectTeam}</div>
            </div>
            <svg className="line-chart" viewBox="0 0 760 300" role="img" aria-label="score chart">
              <rect x="0" y="0" width="760" height="300" fill="#fff" />
              <g stroke="#e5e9f0" strokeWidth="1">
                <path d="M50 25H735M50 65H735M50 105H735M50 145H735M50 185H735M50 225H735M50 265H735" />
                <path d="M50 25V265M130 25V265M210 25V265M290 25V265M370 25V265M450 25V265M530 25V265M610 25V265M690 25V265" />
              </g>
              <polyline
                fill="none"
                stroke="#28a35f"
                strokeWidth="2.5"
                points="50,258 90,250 130,238 170,228 210,212 250,202 290,186 330,176 370,160 410,150 450,134 490,124 530,110 570,100 610,90 650,82 735,76"
              />
              <polyline
                fill="none"
                stroke="#1f78d1"
                strokeWidth="2.5"
                points="50,260 90,253 130,243 170,234 210,220 250,212 290,198 330,190 370,176 410,168 450,154 490,146 530,134 570,127 610,118 650,112 735,107"
              />
              <g fontFamily="JetBrains Mono, monospace" fontSize="11" fill="#344155">
                <text x="22" y="29">
                  3000
                </text>
                <text x="22" y="69">
                  2500
                </text>
                <text x="22" y="109">
                  2000
                </text>
                <text x="22" y="149">
                  1500
                </text>
                <text x="22" y="189">
                  1000
                </text>
                <text x="30" y="229">
                  500
                </text>
                <text x="34" y="269">
                  0
                </text>
              </g>
              <g transform="translate(575 145)">
                <rect width="150" height="74" rx="8" fill="#fff" stroke="#aeb7c5" />
                <text
                  x="13"
                  y="22"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="12"
                  fontWeight="700"
                  fill="#111827"
                >
                  21:50
                </text>
                <path d="M14 42H26" stroke="#1f78d1" strokeWidth="4" strokeLinecap="round" />
                <text
                  x="32"
                  y="45"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="11"
                  fill="#111827"
                >
                  gan 1980 pt
                </text>
                <path d="M14 59H26" stroke="#28a35f" strokeWidth="4" strokeLinecap="round" />
                <text
                  x="32"
                  y="62"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="11"
                  fill="#111827"
                >
                  {t.chartYou}
                </text>
              </g>
            </svg>
            <div className="chart-legend">
              <span style={{ color: "#1f78d1" }}>━ gan</span>
              <span style={{ color: "#28a35f" }}>{t.legendYou}</span>
            </div>
          </div>
          <div className="challenge-card">
            <h4>{t.challengeTitle}</h4>
            <p>{t.challengeBody}</p>
            <span className="tiny-button">{t.openProblems}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Battle preview (score-events panel) ──────────────────────────────────────────
const BATTLE_LABELS: Record<Locale, Record<string, string>> = {
  ja: {
    title: "Score events",
    desc: "自チームのスコア変動履歴 (30 秒ごと自動更新、新しい順 100 件まで)",
    chart: "累計 score 推移",
    history: "履歴 (100)",
    colTime: "発生時刻",
    colProblem: "問題",
    colType: "種類",
    colPoints: "変動",
    timeNow: "数秒前",
    timeMinute: "1 分前",
  },
  en: {
    title: "Score events",
    desc: "Your team's score-change history, auto-refreshed every 30 seconds. Up to 100 newest events.",
    chart: "Cumulative score trend",
    history: "History (100)",
    colTime: "Occurred",
    colProblem: "Problem",
    colType: "Type",
    colPoints: "Delta",
    timeNow: "Seconds ago",
    timeMinute: "1 min ago",
  },
};

export function BattlePreview({ locale }: PreviewProps) {
  const t = BATTLE_LABELS[locale];
  return (
    <div className="portal-preview score-events-preview" aria-hidden="true">
      <div className="portal-page-title">{t.title}</div>
      <div className="portal-page-desc">{t.desc}</div>
      <div className="portal-container">
        <div className="portal-container-title">{t.chart}</div>
        <svg
          className="portal-chart"
          viewBox="0 0 560 210"
          role="img"
          aria-label="score events chart"
        >
          <rect width="560" height="210" fill="#fff" />
          <g stroke="#e5e9f0" strokeWidth="1">
            <path d="M45 20H535M45 58H535M45 96H535M45 134H535M45 172H535" />
            <path d="M45 20V172M125 20V172M205 20V172M285 20V172M365 20V172M445 20V172M535 20V172" />
          </g>
          <polyline
            fill="none"
            stroke="#0972d3"
            strokeWidth="3"
            points="45,165 86,158 126,148 166,140 206,128 246,120 286,108 326,99 366,87 406,79 446,66 535,42"
          />
          <g fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#5d6877">
            <text x="8" y="24">
              2000
            </text>
            <text x="8" y="62">
              1500
            </text>
            <text x="8" y="100">
              1000
            </text>
            <text x="14" y="138">
              500
            </text>
            <text x="18" y="176">
              0
            </text>
            <text x="40" y="197">
              21:37:00
            </text>
            <text x="198" y="197">
              21:43:00
            </text>
            <text x="356" y="197">
              21:49:00
            </text>
          </g>
        </svg>
      </div>
      <div className="portal-container">
        <div className="portal-container-title">{t.history}</div>
        <table className="portal-table">
          <thead>
            <tr>
              <th>{t.colTime}</th>
              <th>{t.colProblem}</th>
              <th>{t.colType}</th>
              <th>{t.colPoints}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t.timeNow}</td>
              <td>
                <code className="portal-code">microservice-migration-battle</code>
              </td>
              <td>
                <span className="portal-badge green">Battle (uptime)</span>
              </td>
              <td>
                <span className="portal-points negative">-100 pt</span>
              </td>
            </tr>
            <tr>
              <td>{t.timeMinute}</td>
              <td>
                <code className="portal-code">hello-world</code>
              </td>
              <td>
                <span className="portal-badge blue">Challenge (flag)</span>
              </td>
              <td>
                <span className="portal-points positive">+800 pt</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Challenge preview (quests panel) ─────────────────────────────────────────────
const CHALLENGE_LABELS: Record<Locale, Record<string, string>> = {
  ja: {
    title: "問題一覧 (Quests)",
    desc: "自チームに deploy された問題のカタログ。各カードからアクセス先 URL に直接遷移できます。",
    all: "すべて (3)",
    unsolved: "未解決 (3)",
    diffMid: "難易度: 中級",
    diffIntro: "難易度: 入門",
    inProgress: "挑戦中",
    unanswered: "未解答",
    cleared: "⌄ 解決済み (0)",
  },
  en: {
    title: "Problem list (Quests)",
    desc: "A catalog of problems deployed to your team. Jump directly to each access URL from its card.",
    all: "All (3)",
    unsolved: "Unsolved (3)",
    diffMid: "Difficulty: intermediate",
    diffIntro: "Difficulty: intro",
    inProgress: "In progress",
    unanswered: "Unanswered",
    cleared: "⌄ Cleared (0)",
  },
};

export function ChallengePreview({ locale }: PreviewProps) {
  const t = CHALLENGE_LABELS[locale];
  return (
    <div className="portal-preview" aria-hidden="true">
      <div className="portal-page-title">{t.title}</div>
      <div className="portal-page-desc">{t.desc}</div>
      <div className="portal-tabs">
        <span className="portal-tab active">{t.all}</span>
        <span className="portal-tab">Battle (2)</span>
        <span className="portal-tab">Challenge (1)</span>
      </div>
      <div className="portal-container">
        <div className="portal-container-title">{t.unsolved}</div>
        <div className="quest-card-list">
          <div className="quest-card">
            <code>microservice-migration-battle</code>
            <span className="portal-badge red">Battle</span>
            <span className="portal-badge grey">{t.diffMid}</span>
            <span className="status-text">{t.inProgress}</span>
          </div>
          <div className="quest-card">
            <code>hello-world</code>
            <span className="portal-badge blue">Challenge</span>
            <span className="portal-badge grey">{t.diffIntro}</span>
            <span className="status-text pending">{t.unanswered}</span>
          </div>
          <div className="quest-card">
            <code>hello-world-battle</code>
            <span className="portal-badge red">Battle</span>
            <span className="portal-badge grey">{t.diffMid}</span>
            <span className="status-text">{t.inProgress}</span>
          </div>
        </div>
      </div>
      <div className="portal-collapsed">{t.cleared}</div>
    </div>
  );
}

// ── SSO credentials preview (security section right column) ──────────────────────
const SSO_LABELS: Record<Locale, Record<string, string>> = {
  ja: {
    sub: "AWS Console にワンクリックで federate ログイン。参加者個人の AWS アカウントは不要 — 主催者が用意した環境へ、ポータルから安全にアクセスできます。",
    howto: "使い方",
    body: "下のボタンを押すと新しいタブで AWS Console が自動でログイン状態で開きます。session の TTL は 1 時間です。",
    button: "AWS Console を開く",
  },
  en: {
    sub: "One-click federated login to AWS Console. No personal AWS account required — participants access the environment the host has prepared, safely from the portal.",
    howto: "How to use",
    body: "Press a button below to open AWS Console, already signed in, in a new tab. The session TTL is one hour.",
    button: "Open AWS Console",
  },
};

const SSO_ROWS = [
  { id: "microservice-migration-battle", account: "c7782015332", region: "us-east-1" },
  { id: "hello-world", account: "677c9285832", region: "ap-northeast-1" },
  { id: "hello-world-battle", account: "677c9285832", region: "us-east-1" },
] as const;

export function SsoPreview({ locale }: PreviewProps) {
  const t = SSO_LABELS[locale];
  return (
    <div className="flow sso-preview" aria-hidden="true">
      <div className="credential-title">SSO Credentials</div>
      <div className="credential-sub">{t.sub}</div>
      <div className="sso-alert">
        <b>{t.howto}</b>
        <span>{t.body}</span>
      </div>
      <div className="credential-list">
        {SSO_ROWS.map((row) => (
          <div className="credential-row" key={row.id}>
            <div className="credential-row-head">
              <code>{row.id}</code>
              <span className="credential-button">{t.button} ↗</span>
            </div>
            <div className="credential-kv">
              <div>
                <span>AWS Account</span>
                <code>{row.account}</code>
              </div>
              <div>
                <span>Region</span>
                <strong>{row.region}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
