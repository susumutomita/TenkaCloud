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
      id: "wp-exposed-backup",
      category: "Challenge",
      status: "draft",
      difficulty: 3,
      tags: ["wordpress", "misconfiguration", "data-exposure", "backup-exposure"],
      name: {
        ja: "前任者の忘れ物",
        en: "The Predecessor's Leftovers",
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
  ],
} as const;
