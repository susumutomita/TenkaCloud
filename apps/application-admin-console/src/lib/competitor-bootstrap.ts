/**
 * Issue #663: 競技者向け bootstrap CFn template の配信 helper。
 * 競技者は本 repo に access できないため、 modal から:
 *   - yaml を copy / download できる button を提供 (= 手動 deploy 経路)
 *   - AWS CFn console の Quick-create URL を発行 (= 1 click deploy 経路)
 *
 * #718: CFn `TemplateURL` は **S3 / SSM の URL のみ** 受け付ける (= raw.githubusercontent.com は
 * "TemplateURL must be a supported URL" で reject される)。 admin-console-hosting stack が
 * deploy 時に public S3 bucket へ同 yaml を upload し、 runtime-config 経由で URL を露出する。
 * 旧 fallback (= GitHub raw) は dev / 未 deploy 環境用にのみ残し、 deploy 後は config 経由で
 * S3 URL に切り替わる。
 */

const TEMPLATE_REPO = "susumutomita/TenkaCloud";
const TEMPLATE_BRANCH = "main";
const TEMPLATE_PATH = "infrastructure/templates/competitor-bootstrap.yaml";
const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_STACK_NAME = "tenkacloud-competitor-bootstrap";

/**
 * dev 環境 / runtime-config 未配線時の fallback URL。 CFn console から fetch すると
 * "TemplateURL must be a supported URL" で reject されるので、 production では config 経由で
 * S3 URL を必ず注入すること。 raw URL 自体は yaml の手 download / レビュー用には引き続き有効。
 */
export const COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK = `https://raw.githubusercontent.com/${TEMPLATE_REPO}/${TEMPLATE_BRANCH}/${TEMPLATE_PATH}`;

function resolveTemplateUrl(templateUrl: string | undefined): string {
  return templateUrl && templateUrl.length > 0
    ? templateUrl
    : COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK;
}

/**
 * Issue #1055: runtime-config に `competitorBootstrapTemplateUrl` が注入されているか判定する。
 * 空 / undefined のとき、 CompetitorAccounts 画面の Launch / Update Stack リンクは GitHub raw
 * fallback を返し、 AWS CFn console が「TemplateURL must be a supported URL」 で reject する。
 * UI 側は本 helper で検出して事前警告 banner を表示する (= operator が壊れたリンクを送る前に
 * 気付く)。
 *
 * #1053 の CDK refactor (= ProblemDeployBackendStack に hosting 移管) 完了で常に注入される
 * ようになれば、 本 helper + 警告 banner は dead code として撤去できる。
 */
export function isBootstrapUrlMissing(templateUrl: string | undefined): boolean {
  return !templateUrl || templateUrl.length === 0;
}

export interface LaunchStackUrlInput {
  readonly tenkaCloudAccountId: string;
  readonly externalId: string;
  readonly competitorRoleName: string;
  readonly region?: string;
  /**
   * #718: CFn TemplateURL 用の S3 URL (= AdminConsoleHostingStack output)。
   * undefined / 空文字なら GitHub raw fallback (= dev 用) を使う。
   */
  readonly templateUrl?: string;
}

/**
 * AWS CFn console の Quick-create deeplink を組み立てる。
 * 競技者は click → SSO → 確認画面 で 1 stack 作成可能。
 */
export function buildLaunchStackUrl(input: LaunchStackUrlInput): string {
  const region = input.region ?? DEFAULT_REGION;
  const params = new URLSearchParams({
    templateURL: resolveTemplateUrl(input.templateUrl),
    stackName: DEFAULT_STACK_NAME,
    param_TenkaCloudAccountId: input.tenkaCloudAccountId,
    param_ExternalId: input.externalId,
    param_RoleName: input.competitorRoleName,
  });
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${params.toString()}`;
}

/**
 * 「すべてコピー」 button が clipboard に書き込む 1 つの整形済 string。
 * 競技者の作業手順 (= Slack / メールでそのまま送れる) を含む。
 *
 * 旧 `buildUpdateStackUrl` / `buildUpdatePayload` (= bootstrap stack の Update Stack deeplink 生成)
 * は仕様簡素化のため廃止 (= ExternalId rotate は新値を operator が共有し、 競技者が CFn console
 * で Parameter を手動更新する経路に統一)。
 */
export function buildShareablePayload(input: LaunchStackUrlInput): string {
  return [
    "TenkaCloud Competitor Bootstrap — お渡しする 3 値",
    "",
    `TenkaCloudAccountId: ${input.tenkaCloudAccountId}`,
    `ExternalId:          ${input.externalId}`,
    `RoleName:            ${input.competitorRoleName}`,
    "",
    "deploy 手順:",
    `1. CFn テンプレ: ${resolveTemplateUrl(input.templateUrl)}`,
    "2. 競技者 AWS account にログインし、 上記 3 値を Parameter として CFn create-stack",
    "3. Quick-create リンク (= 確認画面に pre-fill 済で直接遷移):",
    `   ${buildLaunchStackUrl(input)}`,
    "",
    "完了後 operator にこの mail / msg を返信、 operator が「Verify」 で確認します。",
  ].join("\n");
}
