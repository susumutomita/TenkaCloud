import { adrMustBeHtml } from "./adr-must-be-html.ts";
import { adrSelfContained } from "./adr-self-contained.ts";
import { fileTooLarge } from "./file-too-large.ts";
import { handlerMustNotCallFetch } from "./handler-must-not-call-fetch.ts";
import { handlerNoDirectSdkImport } from "./handler-no-direct-sdk-import.ts";
import { handlerTenantIsolation } from "./handler-tenant-isolation.ts";
import { iamWildcardNeedsJustify } from "./iam-wildcard-needs-justify.ts";
import { lambdaEnvSize } from "./lambda-env-size.ts";
import { noAwsTrademarkFictions } from "./no-aws-trademark-fictions.ts";
import { noConflictMarkers } from "./no-conflict-markers.ts";
import { secretsManagerForbidden } from "./secrets-manager-forbidden.ts";

export const architectureRules = [
  adrMustBeHtml,
  adrSelfContained,
  iamWildcardNeedsJustify,
  // Issue #986 / SOLID 規律強制
  fileTooLarge,
  handlerNoDirectSdkImport,
  // Issue #997 / tenant 分離 audit
  handlerTenantIsolation,
  // feedback_pull_main_before_task: PR の conflict を防ぐ第一線。 commit 内の marker 検知
  noConflictMarkers,
  // Issue #1309 / Lambda env 4KB hard limit 再発防止 (= #1308 root cause)
  lambdaEnvSize,
  // AWS GameDay branding (= Unicorn.Rentals 等) を OSS / 商用 platform で流用しない // allow-aws-fiction: rule self-description
  noAwsTrademarkFictions,
  // CLAUDE.md cost-zero principle: Secrets Manager 禁止 (SSM SecureString を使う)
  secretsManagerForbidden,
  // CLAUDE.md: lib/handlers/ は fetch( を直接呼ばない (HTTP I/O は注入可能な client へ)
  handlerMustNotCallFetch,
] as const;
