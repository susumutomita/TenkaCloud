import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Issue #997: tenant 分離 audit。
 *
 * pooled tier (BASIC / STANDARD / PREMIUM) で application-admin-console が共有 stack で動く
 * 構成上、 全 handler は **request の tenantId を JWT から取り、 DDB read/write に必ず注入する**
 * 必要がある。 1 handler でも tenantId を見ずに query すれば 「TenantA admin が TenantB のデータを
 * 取得」 という公平性破壊バグになる。
 *
 * 本 rule は次を機械検査する:
 *   対象 file: `infrastructure/lib/<...>/handlers/<X>/{index,service}.ts` で
 *              **tenant-scoped** (= participant 系を除く):
 *                - event-handler / competitor-accounts-handler / disruption-fire-handler 等
 *   検査内容: file が DDB 系 Command (= QueryCommand / ScanCommand / UpdateCommand /
 *             DeleteCommand / PutCommand / TransactWriteCommand) を呼び出しているなら、
 *             同 file 内で 「tenantId」 という識別子が **1 度以上** 言及されていること
 *
 * 言及が無い場合 warning。 既存 false positive は baseline で吸収しつつ、 新規 file は必ず
 * tenantId を扱うように ratchet する。
 *
 * 除外:
 *   - participant-handler: teamLoginKey scope (= tenant scope は team 経由で transitive)、 tenantId
 *     を直接持たないので本 rule の対象外
 *   - admin-insight-handler: SystemAdmin 経路の **cross-tenant 集計** が正当な使い方
 *   - shared.ts / types.ts などの非エントリ層: route 越しの enforce 責務外
 *   - generic-scoring-handler の reconciler 系: tenant 越境集計が許される系統 (= SystemAdmin scope)
 */

const DDB_COMMAND_RE =
  /\b(QueryCommand|ScanCommand|UpdateCommand|DeleteCommand|PutCommand|TransactWriteCommand|BatchWriteCommand)\b/;

const INCLUDE_PATH_PREFIXES = [
  "infrastructure/lib/problem-deploy/handlers/event-handler/",
  "infrastructure/lib/problem-deploy/handlers/competitor-accounts-handler/",
  "infrastructure/lib/problem-deploy/handlers/deploy-handler/",
  "infrastructure/lib/problem-deploy/handlers/external-id-audit-handler/",
  "infrastructure/lib/problem-deploy/handlers/disruption-fire-handler/",
  "infrastructure/lib/problem-deploy/handlers/describe-stack-handler/",
] as const;

const EXCLUDE_BASENAMES = new Set([
  "shared.ts",
  "types.ts",
  "constants.ts",
  "route-helpers.ts",
  "auth.ts",
]);

const EXCLUDE_PATTERNS = [/\.test\.tsx?$/, /\/node_modules\//, /\/dist\//];

function shouldInspect(path: string): boolean {
  if (!path.endsWith(".ts")) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  if (!INCLUDE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  const segs = path.split("/");
  const basename = segs[segs.length - 1] ?? "";
  if (EXCLUDE_BASENAMES.has(basename)) return false;
  return true;
}

export const handlerTenantIsolation: Rule = {
  id: "handler-tenant-isolation",
  severity: "warning",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!shouldInspect(path)) continue;
      let content: string;
      try {
        content = ctx.readFile(path);
      } catch {
        continue;
      }
      if (!DDB_COMMAND_RE.test(content)) continue;
      // 「tenantId」 が file 中で 1 度以上現れているか
      if (/\btenantId\b/.test(content)) continue;
      findings.push({
        ruleId: "handler-tenant-isolation",
        severity: "warning",
        filePath: path,
        line: 1,
        match: "no-tenantId-reference",
        message:
          `${path} は DDB Command を呼び出しているが 「tenantId」 識別子に 1 度も触れていない。 ` +
          "pooled tier で cross-tenant データ漏洩のリスクが高い。",
        recommendation:
          "JWT claim から tenantId を取得し、 DDB Query / Scan / Update の WHERE / ConditionExpression に " +
          "tenantId を必ず含めてください。 例: `resolveTenantId(c)` で取得 → ConditionExpression " +
          "`tenantId = :tenantId` で write を atomic に scope する。 詳細: Issue #997。",
      });
    }
    return findings;
  },
};
