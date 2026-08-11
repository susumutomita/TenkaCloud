import { agentRegistryConsistency } from "./agent-registry-consistency.ts";
import { domainNoInfraImport } from "./domain-no-infra-import.ts";
import { fileTooLarge } from "./file-too-large.ts";
import { handlerMustNotCallFetch } from "./handler-must-not-call-fetch.ts";
import { handlerNoDirectSdkImport } from "./handler-no-direct-sdk-import.ts";
import { handlerNoTransitiveCdkImport } from "./handler-no-transitive-cdk-import.ts";
import { handlerTenantIsolation } from "./handler-tenant-isolation.ts";
import { hookCommandTargetExists } from "./hook-command-target-exists.ts";
import { iamWildcardNeedsJustify } from "./iam-wildcard-needs-justify.ts";
import { lambdaEnvSize } from "./lambda-env-size.ts";
import { noAwsTrademarkFictions } from "./no-aws-trademark-fictions.ts";
import { noConflictMarkers } from "./no-conflict-markers.ts";
import { runtimeCompositionRootOnly } from "./runtime-composition-root-only.ts";
import { secretsManagerForbidden } from "./secrets-manager-forbidden.ts";

export const architectureRules = [
  // Issue #2731: principle / manifest / implementation / test / docs drift must fail in CI.
  agentRegistryConsistency,
  iamWildcardNeedsJustify,
  // Issue #986 / SOLID 規律強制
  fileTooLarge,
  handlerNoDirectSdkImport,
  // Issue #2654: Lambda runtime bundles must never pull in the CDK construct library transitively.
  handlerNoTransitiveCdkImport,
  // Issue #997 / tenant 分離 audit
  handlerTenantIsolation,
  // Prevent Claude Code settings drift from referencing deleted local scripts.
  hookCommandTargetExists,
  // feedback_pull_main_before_task: PR の conflict を防ぐ第一線。commit 内の marker 検知
  noConflictMarkers,
  // Issue #1309 / Lambda env 4KB hard limit 再発防止 (= #1308 root cause)
  lambdaEnvSize,
  // AWS GameDay brandingを OSS / 商用 platform で流用しない // allow-aws-fiction: rule self-description
  noAwsTrademarkFictions,
  // CLAUDE.md cost-zero principle: Secrets Manager 禁止 (SSM SecureString を使う)
  secretsManagerForbidden,
  // CLAUDE.md: lib/handlers/ は fetch( を直接呼ばない (HTTP I/O は注入可能な client へ)
  handlerMustNotCallFetch,
  // Issue #2527 Slice 7: domain layer は handlers / adapter / AWS SDK に依存しない
  domainNoInfraImport,
  // Issue #2527 Slice 7: control-data runtime の自己合成は composition root + audit-log のみ
  runtimeCompositionRootOnly,
] as const;
