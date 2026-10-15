// GENERATED FILE — do not edit by hand.
// Produced by apps/developer-portal/scripts/generate-catalog.ts from public problem
// metadata.json files in the problems/ submodule (TenkaCloudChallenge catalog).
// Run 'bun run generate:catalog' after the catalog changes and commit
// this file. 'bun run check:catalog' fails when it is stale vs the submodule
// (a maintainer check; it needs the submodule checked out).

import type { ProblemAuthor } from "../../../../packages/portal-contracts/src/problem-authors";

export type CatalogCategory = "Battle" | "Challenge";
export type CatalogStatus = "ready" | "draft" | "deprecated";

export interface CatalogLocalizedText {
  readonly ja: string;
  readonly en: string;
}

export interface CatalogProblem {
  readonly authors?: readonly ProblemAuthor[];
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
      id: "forensic-casebook",
      category: "Battle",
      status: "draft",
      difficulty: 3,
      tags: ["forensics", "incident-response", "beginner", "evidence"],
      name: {
        ja: "フォレンジック調査室 — 証拠で結論を支える",
        en: "Forensic Casebook — Support Every Conclusion",
      },
    },
    {
      id: "crypto-battle",
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
  ],
} as const;
