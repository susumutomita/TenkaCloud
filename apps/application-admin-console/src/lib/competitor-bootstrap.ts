/**
 * Issue #663: 競技者向け bootstrap CFn template の配信 helper。
 * 競技者は本 repo に access できないため、 modal から:
 *   - yaml を copy / download できる button を提供 (= 手動 deploy 経路)
 *   - AWS CFn console の Quick-create URL を発行 (= 1 click deploy 経路)
 *
 * Launch Stack URL は public repo の raw.githubusercontent.com URL を templateURL に渡し、
 * Parameter 3 つを query string で pre-fill する。 競技者は AWS SSO ログイン 1 回で deploy
 * 確認画面に直行できる。
 */

const TEMPLATE_REPO = "susumutomita/TenkaCloud";
const TEMPLATE_BRANCH = "main";
const TEMPLATE_PATH = "infrastructure/templates/competitor-bootstrap.yaml";
const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_STACK_NAME = "tenkacloud-competitor-bootstrap";

export const COMPETITOR_BOOTSTRAP_TEMPLATE_URL = `https://raw.githubusercontent.com/${TEMPLATE_REPO}/${TEMPLATE_BRANCH}/${TEMPLATE_PATH}`;

export interface LaunchStackUrlInput {
  readonly tenkaCloudAccountId: string;
  readonly externalId: string;
  readonly competitorRoleName: string;
  readonly region?: string;
}

/**
 * AWS CFn console の Quick-create deeplink を組み立てる。
 * 競技者は click → SSO → 確認画面 で 1 stack 作成可能。
 */
export function buildLaunchStackUrl(input: LaunchStackUrlInput): string {
  const region = input.region ?? DEFAULT_REGION;
  const params = new URLSearchParams({
    templateURL: COMPETITOR_BOOTSTRAP_TEMPLATE_URL,
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
    `1. CFn テンプレ: ${COMPETITOR_BOOTSTRAP_TEMPLATE_URL}`,
    "2. 競技者 AWS account にログインし、 上記 3 値を Parameter として CFn create-stack",
    "3. Quick-create リンク (= 確認画面に pre-fill 済で直接遷移):",
    `   ${buildLaunchStackUrl(input)}`,
    "",
    "完了後 operator にこの mail / msg を返信、 operator が「Verify」 で確認します。",
  ].join("\n");
}
