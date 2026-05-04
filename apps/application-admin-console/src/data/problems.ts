/**
 * 問題カタログ。現状は静的 (frontend-baked) だが、将来は backend API から取得する。
 * 1 問題 = 1 CFn テンプレート + メタデータ。
 *
 * カテゴリ:
 *   - "Battle"    リアルタイム対戦競技 (旧 GameDay 形式相当)
 *   - "Challenge" 個別演習・常設チャレンジ (旧 JAM 形式相当)
 *
 * status:
 *   - "ready"      参加者向けデプロイ可能
 *   - "draft"      問題本体は揃っているが UI / backend 連携が未完
 *   - "deprecated" 停止予定
 */

export type ProblemCategory = "Battle" | "Challenge";
export type ProblemStatus = "ready" | "draft" | "deprecated";

export interface ProblemSummary {
  id: string;
  name: string;
  category: ProblemCategory;
  status: ProblemStatus;
  /** カード表示用の 1 行サマリ */
  shortDescription: string;
  /** 想定難易度 (1=入門 / 5=エキスパート) */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** 想定プレイ時間 */
  estimatedDuration: string;
  tags: readonly string[];
}

export interface ProblemDetail extends ProblemSummary {
  /** Markdown 風の長文 (改行 OK)。詳細ページに丸ごと表示する */
  description: string;
  /** 参加者がアクセスする想定ポート */
  exposedPorts: readonly { port: number; name: string }[];
  /** 学習目的 (シナリオ作者からのねらい) */
  learningGoals: readonly string[];
}

const SECURITY_BATTLE_ROYALE: ProblemDetail = {
  id: "security-battle-royale",
  name: "Security Battle Royale",
  category: "Battle",
  status: "draft",
  shortDescription:
    "意図的に脆弱性を仕込んだ Web アプリを攻撃 / 防御し、競技アカウント上で生き残るチームを決める。",
  difficulty: 3,
  estimatedDuration: "60〜90 分",
  tags: ["security", "web", "sql-injection", "rce", "ssrf"],
  exposedPorts: [
    { port: 80, name: "frontend (nginx)" },
    { port: 8080, name: "api (Flask)" },
  ],
  learningGoals: [
    "意図的な SQL injection / RCE / SSRF を発見・修正する一連の手順を体験する",
    "EC2 IMDS / IAM Role の露出経路と、それを塞ぐベストプラクティスを理解する",
    "競技中に同居する攻撃者と防御者のトレードオフ (可用性を保ちつつ守る) を体験する",
  ],
  description: [
    "ECサイト風の Web アプリ「Unicorn.Rentals」を題材に、SQL injection / リモートコード実行 / SSRF / IMDS 露出を含む複数の脆弱性が仕込まれた状態でデプロイされる。",
    "",
    "競技参加者は次のいずれかのロールでプレイする。",
    "  - **攻撃側**: 他チームの公開エンドポイントを巡回し、得点リソースを奪取する。",
    "  - **防御側**: 自チームのアプリを継続稼働させたまま、脆弱性を順次塞いでいく。",
    "",
    "デプロイ単位は EC2 1 台 + Docker 構成 (mysql / Flask api / nginx frontend)。デプロイ完了後、参加者には Frontend URL と API URL が払い出される。",
  ].join("\n"),
};

export const PROBLEM_CATALOG: readonly ProblemDetail[] = [SECURITY_BATTLE_ROYALE];

export function findProblem(id: string): ProblemDetail | undefined {
  return PROBLEM_CATALOG.find((p) => p.id === id);
}

export function listProblemSummaries(): readonly ProblemSummary[] {
  return PROBLEM_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    status: p.status,
    shortDescription: p.shortDescription,
    difficulty: p.difficulty,
    estimatedDuration: p.estimatedDuration,
    tags: p.tags,
  }));
}
