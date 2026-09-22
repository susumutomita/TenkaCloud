// GENERATED FILE — do not edit by hand.
// Produced by apps/developer-portal/scripts/generate-catalog.ts from public problem
// metadata.json files in the problems/ submodule (TenkaCloudChallenge catalog).
// Run 'bun run generate:catalog' after the catalog changes and commit
// this file. 'bun run check:catalog' fails when it is stale vs the submodule
// (a maintainer check; it needs the submodule checked out).

export type CatalogCategory = "Battle" | "Challenge";
export type CatalogStatus = "ready" | "draft" | "deprecated";

export interface CatalogLocalizedText {
  readonly ja: string;
  readonly en: string;
}

export interface CatalogProblem {
  readonly id: string;
  readonly category: CatalogCategory;
  readonly status: CatalogStatus;
  readonly difficulty: number;
  readonly tags: readonly string[];
  readonly name: CatalogLocalizedText;
}

export interface CatalogData {
  readonly problems: readonly CatalogProblem[];
}

export const CATALOG_DATA: CatalogData = {
  problems: [
    {
      id: "hello-world-battle",
      category: "Battle",
      status: "ready",
      difficulty: 1,
      tags: ["sample", "battle", "uptime", "ec2"],
      name: {
        ja: "Hello World Battle (Sample)",
        en: "Hello World Battle (Sample)",
      },
    },
    {
      id: "office-link-battle",
      category: "Battle",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "teamwork", "battle"],
      name: {
        ja: "つながるオフィス — AWS復旧Battle",
        en: "Office Link — AWS Recovery Battle",
      },
    },
    {
      id: "microservice-migration-battle",
      category: "Battle",
      status: "ready",
      difficulty: 4,
      tags: ["microservices", "migration", "lambda", "ecs"],
      name: {
        ja: "Microservice Migration Battle",
        en: "Microservice Migration Battle",
      },
    },
    {
      id: "security-battle-royale",
      category: "Battle",
      status: "ready",
      difficulty: 4,
      tags: ["security", "web", "incident-response", "uptime"],
      name: {
        ja: "Security Battle Royale",
        en: "Security Battle Royale",
      },
    },
    {
      id: "stackstack",
      category: "Battle",
      status: "ready",
      difficulty: 4,
      tags: ["platform-engineering", "ai-native", "governance", "waf"],
      name: {
        ja: "StackStack — Vibe to Production",
        en: "StackStack — Vibe to Production",
      },
    },
    {
      id: "agent-approval-gameday",
      category: "Battle",
      status: "draft",
      difficulty: 3,
      tags: ["ai-agent", "mcp", "incident-response", "least-privilege"],
      name: {
        ja: "Enter を押す前に",
        en: "Before You Press Enter",
      },
    },
    {
      id: "ac26-crypto-battle",
      category: "Battle",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography", "advanced-cryptography-2026", "secret-sharing", "shamir"],
      name: {
        ja: "暗号バトル",
        en: "Cryptography Battle",
      },
    },
    {
      id: "db-battle-slow-apparently",
      category: "Battle",
      status: "draft",
      difficulty: 4,
      tags: ["database", "postgresql", "battle", "local-play"],
      name: {
        ja: "DBが遅いらしい",
        en: "The Database Is Slow, Apparently",
      },
    },
    {
      id: "sre-incident-readiness",
      category: "Battle",
      status: "draft",
      difficulty: 4,
      tags: ["sre", "observability", "incident-response", "reliability"],
      name: {
        ja: "見えるものしか守れない",
        en: "You Can Only Defend What You Can See",
      },
    },
    {
      id: "stackstack-gameday",
      category: "Battle",
      status: "draft",
      difficulty: 5,
      tags: ["stackstack", "local-play", "container", "gameday"],
      name: {
        ja: "StackStack GameDay — 1 日ぶんを 1 本で",
        en: "StackStack GameDay — A Whole Day, In One Run",
      },
    },
    {
      id: "event-host-rehearsal",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["organizer", "runbook", "beginner", "local-play"],
      name: {
        ja: "はじめての開催責任者",
        en: "First-time event host",
      },
    },
    {
      id: "hello-world",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["sample", "challenge", "flag", "ssm"],
      name: {
        ja: "Hello World (Sample)",
        en: "Hello World (Sample)",
      },
    },
    {
      id: "office-file-delivery",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "s3", "teamwork"],
      name: {
        ja: "拠点へ資料を届けよう — S3入門",
        en: "Deliver a handover note — S3 basics",
      },
    },
    {
      id: "office-file-recovery",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "s3", "teamwork"],
      name: {
        ja: "消えた案内を取り戻そう — S3の過去版",
        en: "Recover the handover note — S3 versions",
      },
    },
    {
      id: "office-handover-record",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "dynamodb", "teamwork"],
      name: {
        ja: "引き継ぎ台帳を作ろう — DynamoDB入門",
        en: "Keep a team handover record — DynamoDB basics",
      },
    },
    {
      id: "office-job-queue",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "sqs", "teamwork"],
      name: {
        ja: "拠点をまたぐ仕事のバトン — SQS入門",
        en: "Pass jobs between sites — SQS basics",
      },
    },
    {
      id: "office-lambda-delivery",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "lambda", "cloudwatch"],
      name: {
        ja: "3個の荷物を受け付けよう — Lambda入門",
        en: "Accept three parcels — Lambda basics",
      },
    },
    {
      id: "office-link-gate",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "teamwork", "aws", "ec2"],
      name: {
        ja: "つながるオフィスの準備 — AWS入門Challenge",
        en: "Office Link Preparation — AWS Intro Challenge",
      },
    },
    {
      id: "office-log-investigation",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "lambda", "cloudwatch"],
      name: {
        ja: "荷物の行き先を追え — CloudWatch Logs入門",
        en: "Trace the parcel destination — CloudWatch Logs basics",
      },
    },
    {
      id: "office-server-watch",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["beginner", "aws", "cpu-alarm", "teamwork"],
      name: {
        ja: "サーバーの見張り役 — CloudWatch入門",
        en: "Watch the team server — CloudWatch basics",
      },
    },
    {
      id: "stackstack-onboarding",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["onboarding", "stackstack", "getting-started", "local-play"],
      name: {
        ja: "初日の 15 分",
        en: "The First Fifteen Minutes",
      },
    },
    {
      id: "wp-exposed-backup",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      tags: ["wordpress", "misconfiguration", "data-exposure", "backup-exposure"],
      name: {
        ja: "前任者の忘れ物",
        en: "The Predecessor's Leftovers",
      },
    },
    {
      id: "csrf-demo",
      category: "Challenge",
      status: "ready",
      difficulty: 2,
      tags: ["web-security", "csrf", "owasp", "ipa"],
      name: {
        ja: "報告されたリンクの罠",
        en: "The Reported Link Trap",
      },
    },
    {
      id: "sha256-bytes-padding",
      category: "Challenge",
      status: "ready",
      difficulty: 2,
      tags: ["sha256", "hash-function", "padding", "endianness"],
      name: {
        ja: "SHA-256 その 1: バイト列とパディング",
        en: "SHA-256 part 1: bytes and padding",
      },
    },
    {
      id: "xss-demo",
      category: "Challenge",
      status: "ready",
      difficulty: 2,
      tags: ["web-security", "xss", "owasp", "ipa"],
      name: {
        ja: "社内掲示板の忍び込み",
        en: "Breaking Into the Staff Bulletin Board",
      },
    },
    {
      id: "cloudflare-api-security",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["challenge", "flag", "cloudflare-workers", "api-security"],
      name: {
        ja: "Cloudflare Workers プロフィール API — 5 段階セキュリティ採点",
        en: "Cloudflare Workers Profile API — 5-Stage Security Scoring",
      },
    },
    {
      id: "github-oidc-trust-boundary",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["github-actions", "oidc", "aws", "iam"],
      name: {
        ja: "そのトークンは、どのworkflowのもの？",
        en: "Which Workflow Is This Token From?",
      },
    },
    {
      id: "http-query",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["http", "rfc-10008", "query-method", "alb"],
      name: {
        ja: "QUERY: 誰も知らないメソッド",
        en: "QUERY: The Method Nobody Knows",
      },
    },
    {
      id: "sha256-schedule-logic",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["sha256", "hash-function", "bitwise", "message-schedule"],
      name: {
        ja: "SHA-256 その 2: ビット演算とメッセージスケジュール",
        en: "SHA-256 part 2: bit operations and the message schedule",
      },
    },
    {
      id: "signed-does-not-mean-safe",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["npm", "supply-chain", "provenance", "attestation"],
      name: {
        ja: "署名済みなら、安全？",
        en: "Signed Does Not Mean Safe",
      },
    },
    {
      id: "stackstack-defend",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "local-play", "container", "web-app"],
      name: {
        ja: "止めずに直す",
        en: "Fix It Without Taking It Down",
      },
    },
    {
      id: "stackstack-observability",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "observability", "logging", "metrics"],
      name: {
        ja: "黙っているアプリに口を割らせる",
        en: "Making a Silent App Talk",
      },
    },
    {
      id: "stackstack-recover",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "incident-response", "availability", "least-privilege"],
      name: {
        ja: "戻さないで直す",
        en: "Fix It Without Rolling It Back",
      },
    },
    {
      id: "stackstack-safe-exposure",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "authorization", "authentication", "multi-tenant"],
      name: {
        ja: "誰に見せるかを決める",
        en: "Deciding Who Sees What",
      },
    },
    {
      id: "stackstack-secrets",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "secrets", "credentials", "least-privilege"],
      name: {
        ja: "板に載ってしまった鍵",
        en: "The Key That Made It Onto the Board",
      },
    },
    {
      id: "stackstack-ship",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "deploy", "release", "secrets"],
      name: {
        ja: "外から見えるところまで",
        en: "As Far As the Outside",
      },
    },
    {
      id: "stackstack-vibe-build",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["stackstack", "ai-assisted", "code-review", "requirements"],
      name: {
        ja: "AI が書いた検索を、 出荷できる状態にする",
        en: "Ship the search your AI wrote",
      },
    },
    {
      id: "x402-paywall",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      tags: ["challenge", "flag", "waf", "x402"],
      name: {
        ja: "x402 課金ゲート — 課金しているのに 0 USDC",
        en: "The x402 Paywall That Collects Nothing",
      },
    },
    {
      id: "ai-riscv-soc-repair",
      category: "Challenge",
      status: "ready",
      difficulty: 4,
      tags: ["risc-v", "rv32i", "systemverilog", "verilator"],
      name: {
        ja: "AI製RISC-V SoCを起動せよ",
        en: "Boot the AI-Built RISC-V SoC",
      },
    },
    {
      id: "secure-ota-rollback",
      category: "Challenge",
      status: "ready",
      difficulty: 4,
      tags: ["automotive-security", "ota", "ecu", "ed25519"],
      name: {
        ja: "Northstar OTA復旧任務",
        en: "Northstar OTA Recovery Mission",
      },
    },
    {
      id: "sha256-compress-digest",
      category: "Challenge",
      status: "ready",
      difficulty: 4,
      tags: ["sha256", "hash-function", "compression-function", "avalanche"],
      name: {
        ja: "SHA-256 その 3: 圧縮関数と digest、そしてパスワード保存",
        en: "SHA-256 part 3: the compression function, the digest, and password storage",
      },
    },
    {
      id: "ac26-bridge-experiment",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["advanced-cryptography-2026", "bridge", "experimental-method", "modular-arithmetic"],
      name: {
        ja: "予測してから走らせる",
        en: "Predict, then run",
      },
    },
    {
      id: "ac26-bridge-unknown-x",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["advanced-cryptography-2026", "bridge", "drill", "school-algebra"],
      name: {
        ja: "x を知らないまま、足し算が済む",
        en: "The addition finishes without ever knowing x",
      },
    },
    {
      id: "db-a1-table-primary-key",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "重複した会員 — Table / Row / Primary Key",
        en: "Duplicate Members — Table / Row / Primary Key",
      },
    },
    {
      id: "hello-multicloud",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["sample", "multicloud", "composite", "smoke-test"],
      name: {
        ja: "Hello Multicloud (Sample)",
        en: "Hello Multicloud (Sample)",
      },
    },
    {
      id: "stackstack-first-request",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["stackstack", "getting-started", "local-play", "container"],
      name: {
        ja: "はじめてのリクエスト",
        en: "Your First Request",
      },
    },
    {
      id: "wix-exposure-audit",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["saas-security", "misconfiguration", "data-exposure", "privacy"],
      name: {
        ja: "公開設定の置き土産",
        en: "Publishing Settings Left Behind",
      },
    },
    {
      id: "ac26-bridge-clock",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["advanced-cryptography-2026", "bridge", "drill", "modular-arithmetic"],
      name: {
        ja: "余りで計算し、覆いの使い回しを見破る",
        en: "Calculate with remainders and expose cover reuse",
      },
    },
    {
      id: "api-idor-demo",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["api-security", "idor", "bola", "owasp"],
      name: {
        ja: "管理者のメモ",
        en: "The Admin's Note",
      },
    },
    {
      id: "cs-range-boundary-report",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["cs-foundations", "boundary", "off-by-one", "date-range"],
      name: {
        ja: "先週の数字に、先週じゃない日が入っている",
        en: "Last week's number counts a day that is not last week",
      },
    },
    {
      id: "db-a10-primary-replica",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "Primary / Replica ── 複製は「コピー」ではなく「追従」",
        en: "Primary / Replica — a replica is not a copy, it follows",
      },
    },
    {
      id: "db-a11-replication-lag",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "Replication Lag ── 発生させ、観測し、解消する",
        en: "Replication Lag — induce it, observe it, resolve it",
      },
    },
    {
      id: "db-a12-partition",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "大量削除の単位 ── row か partition か",
        en: "The unit of a bulk delete — row, or partition?",
      },
    },
    {
      id: "db-a2-index-tradeoff",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "遅い注文検索 — Index の read/write trade-off",
        en: "The Slow Order Lookup — Index Read/Write Trade-off",
      },
    },
    {
      id: "db-a3-query-plan",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "使い分けられない index — Query Plan と選択性",
        en: "The Index That Doesn't Get Used — Query Plans and Selectivity",
      },
    },
    {
      id: "db-a4-transaction",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "先に届いたお金 — Transaction と原子性",
        en: "The Money That Arrived First — Transactions and Atomicity",
      },
    },
    {
      id: "db-a6-lock",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "詰まっているのは query か、それとも lock 待ちか — Row Lock",
        en: "Is it the query that's slow, or are you just waiting on a lock? — Row Locks",
      },
    },
    {
      id: "db-a7-mvcc",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "書き込み中でも読み取りは待たされない理由 — MVCC と行バージョン",
        en: "Why reads aren't blocked by a write in progress — MVCC and row versions",
      },
    },
    {
      id: "db-a8-delete-vacuum",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "drill", "local-play"],
      name: {
        ja: "DELETE したのに disk が減らない ── 論理削除と物理回収は別物",
        en: "DELETE happened, disk didn't shrink — logical delete and physical reclaim are different things",
      },
    },
    {
      id: "db-challenge-blocked-transaction",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "challenge", "local-play"],
      name: {
        ja: "支払いの書き込みが止まったまま返ってこない",
        en: "A Payout Write Never Comes Back",
      },
    },
    {
      id: "db-challenge-slow-query",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["database", "postgresql", "challenge", "local-play"],
      name: {
        ja: "顧客の注文履歴が返ってこない",
        en: "The Customer's Order History Never Loads",
      },
    },
    {
      id: "sqli-demo",
      category: "Challenge",
      status: "draft",
      difficulty: 2,
      tags: ["web-security", "sql-injection", "owasp", "ipa"],
      name: {
        ja: "スタッフ専用ログイン",
        en: "Staff-Only Login",
      },
    },
    {
      id: "ac26-bridge-properties",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "bridge", "security-properties", "soundness"],
      name: {
        ja: "満たす性質、破る性質",
        en: "What it holds, what it breaks",
      },
    },
    {
      id: "ac26-w1-constraint-lab",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week1", "arithmetic-circuit", "constraint-system"],
      name: {
        ja: "0 になるべき式の集まり",
        en: "A set of things that must be zero",
      },
    },
    {
      id: "ac26-w2-beaver-mul",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "beaver-triple"],
      name: {
        ja: "掛け算だけが話を必要とする",
        en: "Multiplication is the one that has to talk",
      },
    },
    {
      id: "ac26-w2-linear-shares",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "secret-sharing"],
      name: {
        ja: "誰とも話さずにできること",
        en: "What you can do without talking to anyone",
      },
    },
    {
      id: "ac26-w2-oblivious-transfer",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "oblivious-transfer"],
      name: {
        ja: "選んだことを言わずに、選ぶ",
        en: "Choosing without saying which",
      },
    },
    {
      id: "ac26-w2-secret-sharing",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "secret-sharing"],
      name: {
        ja: "分けても、まだ何も分からない",
        en: "Split it, and still nobody knows",
      },
    },
    {
      id: "ac26-w3-fft-domain",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "fft", "roots-of-unity", "interpolation"],
      name: {
        ja: "その domain、本当に割り切れますか",
        en: "Does that domain actually divide?",
      },
    },
    {
      id: "ac26-w3-field-inverse",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week3", "finite-field", "modular-inverse"],
      name: {
        ja: "曲線の前に、体を作る",
        en: "Build the field before the curve",
      },
    },
    {
      id: "ac26-w3-ntt-roots",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week3", "finite-field", "roots-of-unity"],
      name: {
        ja: "その omega は、本当に n 乗して初めて 1 になるか",
        en: "Does that omega really take n powers to reach 1?",
      },
    },
    {
      id: "ac26-w3-passkey-assertion",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week3", "passkey", "webauthn"],
      name: {
        ja: "署名は正しい。それでも拒否する",
        en: "The signature is valid. Reject it anyway.",
      },
    },
    {
      id: "ac26-w3-schnorr-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week3", "drill", "finite-field"],
      name: {
        ja: "秘密を送らずに確かめる — Schnorrの順番を試す",
        en: "Check without sending the secret — test the order of Schnorr",
      },
    },
    {
      id: "ac26-w4-fri-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week4", "drill", "fri"],
      name: {
        ja: "折り畳んだ式のすり替えを見つける",
        en: "Catch an altered polynomial fold",
      },
    },
    {
      id: "ac26-w4-plonk-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week4", "drill", "plonk"],
      name: {
        ja: "ゲートは全部通る。配線が違う",
        en: "The gates pass, but the wires are wrong",
      },
    },
    {
      id: "ac26-w4-sumcheck-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week4", "drill", "sumcheck"],
      name: {
        ja: "合計のごまかしを、短い式で見つける",
        en: "Catch a false sum with short expressions",
      },
    },
    {
      id: "ac26-w5-encoding-noise",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "encoding"],
      name: {
        ja: "どこまで押せるか",
        en: "How far can it be pushed",
      },
    },
    {
      id: "ac26-w5-negacyclic-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week5", "drill", "tfhe"],
      name: {
        ja: "符号の裏返りで計算し、ずれに強くする",
        en: "Compute with sign flips, then tolerate more noise",
      },
    },
    {
      id: "ac26-w5-rotation-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week5", "drill", "tfhe"],
      name: {
        ja: "答えの表を回して、ずれに強い計算を作る",
        en: "Rotate an answer table and repair its error tolerance",
      },
    },
    {
      id: "ac26-w6-cosnark-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week6", "drill", "co-snark"],
      name: {
        ja: "二人で分担して、秘密の数を掛ける",
        en: "Multiply shared secrets together",
      },
    },
    {
      id: "ac26-w6-nullifier-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["ac26", "zk", "nullifier", "privacy"],
      name: {
        ja: "名前を出さずに、二票目を見分ける",
        en: "Detect a second vote without a name",
      },
    },
    {
      id: "ac26-w6-zkvm-trace-drill",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["advanced-cryptography-2026", "week6", "drill", "zkvm"],
      name: {
        ja: "計算の記録から、不正な承認を見つける",
        en: "Find an improper acceptance in the execution trace",
      },
    },
    {
      id: "acm-validation-migration",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["aws", "acm", "dns", "route53"],
      name: {
        ja: "証明書のARNは変えずに、検証方式だけを乗り換える",
        en: "Keep the certificate ARN. Switch only the validation method",
      },
    },
    {
      id: "cs-async-result-binding",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "python", "asyncio", "concurrency"],
      name: {
        ja: "先に返ったのは、どの request の結果だろう",
        en: "Which request did that early result belong to?",
      },
    },
    {
      id: "cs-atomic-file-publish",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "filesystem", "atomicity", "durability"],
      name: {
        ja: "半分のファイルは、ファイルではない",
        en: "Half a file is not a file",
      },
    },
    {
      id: "cs-auth-claim-audit",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "authorization", "audit", "local-play"],
      name: {
        ja: "署名は通った。それは、その要求を通してよいという意味ではない",
        en: "The signature checked out. That is not the same as the request being allowed",
      },
    },
    {
      id: "cs-cache-generation-fence",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "cache", "invalidation", "concurrency"],
      name: {
        ja: "消した。それでも古い値が戻ってきた",
        en: "Deleted. The old value still came back",
      },
    },
    {
      id: "cs-dst-daily-rollup",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "time", "timezone", "dst"],
      name: {
        ja: "年に 2 日だけ、日次レポートが合わない",
        en: "Two days a year, the report is wrong",
      },
    },
    {
      id: "cs-http-retry-idempotency",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "http", "idempotency", "sqlite"],
      name: {
        ja: "応答が消えた。再送で同じ支払いを増やさない",
        en: "The response vanished. Do not create the payment again",
      },
    },
    {
      id: "cs-numeric-aggregation-order",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "numerics", "decimal", "rounding"],
      name: {
        ja: "誰も数字を変えていないのに、合計が変わった",
        en: "The total changed when nobody changed the numbers",
      },
    },
    {
      id: "cs-pagination-drift",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "pagination", "cursor", "consistency"],
      name: {
        ja: "ページは正しい。一覧が揃わない",
        en: "Every page is right. The listing is not",
      },
    },
    {
      id: "cs-protocol-state-guard",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "protocol", "state-machine", "validation"],
      name: {
        ja: "ハンドシェイクは、結局なくてもよかった",
        en: "The handshake was optional after all",
      },
    },
    {
      id: "cs-transaction-visibility-audit",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["cs-foundations", "transactions", "mvcc", "audit"],
      name: {
        ja: "どちらも committed。だが、その合計は一度も存在しない",
        en: "Both reads were committed. The total never existed",
      },
    },
    {
      id: "eventbridge-delivery-discipline",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["aws", "eventbridge", "idempotency", "ordering"],
      name: {
        ja: "二度届いて、前後する",
        en: "Delivered Twice, Arrived Out of Order",
      },
    },
    {
      id: "festivalgate-terminal-api",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["api-security", "trust-boundary", "least-privilege", "data-minimization"],
      name: {
        ja: "入場端末の信頼境界",
        en: "Trust Boundaries at the Entrance Terminal",
      },
    },
    {
      id: "hollow-invite",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["incident-response", "phishing", "social-engineering", "email-authentication"],
      name: {
        ja: 'Operation "Hollow Invite"',
        en: 'Operation "Hollow Invite"',
      },
    },
    {
      id: "mcp-origin-guardian",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["mcp", "oauth", "origin-validation", "host-header"],
      name: {
        ja: "信頼できる入口はどこ?",
        en: "Which Entrance Can You Trust?",
      },
    },
    {
      id: "rls-tenant-isolation",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["web-security", "multi-tenant", "row-level-security", "postgres"],
      name: {
        ja: "マルチテナント情報漏洩 — Postgres RLS でテナント境界を守る",
        en: "Multi-Tenant Data Leak — Enforce the Boundary with Postgres RLS",
      },
    },
    {
      id: "wp-harden-leaks",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["wordpress", "misconfiguration", "remediation", "hardening"],
      name: {
        ja: "後任の大掃除",
        en: "The Successor's Cleanup",
      },
    },
    {
      id: "wp-midnight-admin",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["wordpress", "incident-response", "account-compromise", "log-analysis"],
      name: {
        ja: "深夜の管理者",
        en: "The Midnight Admin",
      },
    },
    {
      id: "ac26-w1-underconstraint",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week1", "underconstraint", "soundness"],
      name: {
        ja: "通るのに、守れていない",
        en: "It passes, but it does not protect",
      },
    },
    {
      id: "ac26-w2-privacy-audit",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "privacy"],
      name: {
        ja: "答えは合っている。それだけだ",
        en: "The answer is right. That is all it is",
      },
    },
    {
      id: "ac26-w3-nonce-reuse",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week3", "nonce-reuse", "special-soundness"],
      name: {
        ja: "乱数再利用から署名の秘密鍵を復元する",
        en: "Recover a signing key from nonce reuse",
      },
    },
    {
      id: "ac26-w4-arithmetization",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week4", "zkp", "arithmetization"],
      name: {
        ja: "多項式にしただけでは証明ではない",
        en: "Turning it into a polynomial is not a proof",
      },
    },
    {
      id: "ac26-w4-commit-open",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week4", "zkp", "commitment"],
      name: {
        ja: "先に聞かれたら、何でも通せる",
        en: "Ask me first and I can pass anything",
      },
    },
    {
      id: "ac26-w4-proof-pipeline",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week4", "zkp", "proof-system"],
      name: {
        ja: "9 層ある 1 個の箱",
        en: "One box with nine layers",
      },
    },
    {
      id: "ac26-w5-cmux-blind-rotation",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "tfhe"],
      name: {
        ja: "誰も知らない角度で回す",
        en: "Turn it by an angle nobody knows",
      },
    },
    {
      id: "ac26-w5-extract-key-switch",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "tfhe"],
      name: {
        ja: "同じ数を、別の鍵の言葉で言う",
        en: "Say the same number in another key's words",
      },
    },
    {
      id: "ac26-w5-lwe-rlwe",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "lwe"],
      name: {
        ja: "符号 1 つと、その下流すべて",
        en: "One sign, and everything downstream",
      },
    },
    {
      id: "ac26-w5-rgsw-external",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "rgsw"],
      name: {
        ja: "誰にも読めないビットを掛ける",
        en: "Multiply by a bit nobody can read",
      },
    },
    {
      id: "ac26-w6-cosnark-beaver",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week6", "mpc", "co-snark"],
      name: {
        ja: "誰も持っていない 2 つの値を、1 round だけ話して掛ける",
        en: "Multiply two values nobody holds, with one round of talking",
      },
    },
    {
      id: "ac26-w6-cosnark-linear",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["advanced-cryptography-2026", "week6", "mpc", "co-snark"],
      name: {
        ja: "共同証明の準備：秘密を分けたまま足す",
        en: "Prepare a joint proof: add without combining secrets",
      },
    },
    {
      id: "asm-worst-case-latency",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["cs-foundations", "assembly", "cpu", "cache"],
      name: {
        ja: "1 命令を、どこまで遅くできるか",
        en: "One instruction, as slow as you can make it",
      },
    },
    {
      id: "wp2shell-friday-night-patch",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["wordpress", "incident-response", "waf", "rest-api"],
      name: {
        ja: "金曜深夜のパッチ当て",
        en: "Friday Night Patch",
      },
    },
    {
      id: "wp2shell-local-lab",
      category: "Challenge",
      status: "draft",
      difficulty: 4,
      tags: ["wordpress", "rest-api", "batch-processing", "query-construction"],
      name: {
        ja: "予行演習",
        en: "The Dry Run",
      },
    },
    {
      id: "ac26-w2-private-aggregate",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week2", "mpc", "beaver-triple"],
      name: {
        ja: "掛け算は 5 回、通信は 1 回",
        en: "Five multiplications, one round",
      },
    },
    {
      id: "ac26-w3-ec-group",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week3", "elliptic-curve", "group-law"],
      name: {
        ja: "(0, 0) は無限遠点ではない",
        en: "(0, 0) is not the point at infinity",
      },
    },
    {
      id: "ac26-w3-schnorr",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week3", "schnorr", "fiat-shamir"],
      name: {
        ja: "何をハッシュに入れ忘れたか",
        en: "What did you leave out of the hash",
      },
    },
    {
      id: "ac26-w5-pbs-homnand",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week5", "fhe", "tfhe"],
      name: {
        ja: "暗号文のまま関数を引き、入力の鍵へ戻す",
        en: "Look up a function on a ciphertext, and return to the input key",
      },
    },
    {
      id: "ac26-w6-cosnark-privacy",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week6", "mpc", "co-snark"],
      name: {
        ja: "同じ答えを返す 8 つの prover が、 それぞれ別のことを言っている",
        en: "Eight provers that agree on the answer and disagree on what they say",
      },
    },
    {
      id: "ac26-w6-stack-design",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week6", "stack-design", "composition"],
      name: {
        ja: "暗号部品のつなぎ方を点検する",
        en: "Review how cryptographic components are connected",
      },
    },
    {
      id: "ac26-w6-zkvm-exploit-predicate",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week6", "zkvm", "proof-of-exploit"],
      name: {
        ja: "オーバーフローは 2 か所で起きる。 証明はどちらの話かを名指す",
        en: "The overflow happens in two places, and a proof has to say which",
      },
    },
    {
      id: "ac26-w6-zkvm-witness-binding",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week6", "zkvm", "proof-of-exploit"],
      name: {
        ja: "証明は valid だった。 ただし、 別の口座についての証明だった",
        en: "The proof was valid. It was a proof about a different account",
      },
    },
    {
      id: "ac26-w7-capstone-demo",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week7", "capstone", "secure-aggregation"],
      name: {
        ja: "主張と、それを反証できる実験",
        en: "A claim, and the experiment that could refute it",
      },
    },
    {
      id: "ac26-w7-capstone-design",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["advanced-cryptography-2026", "week7", "capstone", "threat-model"],
      name: {
        ja: "依頼書から暗号システムを設計する",
        en: "Design a cryptographic system from its requirements",
      },
    },
    {
      id: "ai-riscv-screen-repair",
      category: "Challenge",
      status: "draft",
      difficulty: 5,
      tags: ["risc-v", "rv32i", "systemverilog", "verilator"],
      name: {
        ja: "AI製RISC-V画面を復旧せよ",
        en: "Repair the AI-Built RISC-V Screen",
      },
    },
  ],
} as const;
