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

/**
 * @deprecated #718: const は dev fallback。 production では runtime-config の
 * `competitorBootstrapTemplateUrl` を参照し、 builder 関数に渡すこと。
 */
export const COMPETITOR_BOOTSTRAP_TEMPLATE_URL = COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK;

function resolveTemplateUrl(templateUrl: string | undefined): string {
  return templateUrl && templateUrl.length > 0
    ? templateUrl
    : COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK;
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
 * #706: 既存 `tenkacloud-competitor-bootstrap` stack を **同 template の最新版** で update する
 * deeplink を組み立てる。 PR-694 のような IAM 追加を反映するため operator が競技者に共有する用途。
 *
 * AWS CFn console の Update Stack 経路は `#/stacks/update/template` で、 `stackName` 指定 +
 * `templateURL` 指定で 「Replace current template」 で update する。 既存 Parameter 値は競技者の
 * CFn console 側で **Use existing value** が default になるため operator が externalId 等の
 * 秘密値を再送する必要は無い。 SSO ログイン後 → 確認画面で diff を見せた上で 1 click で update できる。
 *
 * `region` は operator がレコードから渡す (= 別 region に bootstrap が無い前提)。
 */
export interface UpdateStackUrlInput {
  readonly region?: string;
  /** #718: CFn TemplateURL 用の S3 URL。 undefined / 空文字なら GitHub raw fallback。 */
  readonly templateUrl?: string;
}

export function buildUpdateStackUrl(input: UpdateStackUrlInput = {}): string {
  const region = input.region ?? DEFAULT_REGION;
  const params = new URLSearchParams({
    stackName: DEFAULT_STACK_NAME,
    templateURL: resolveTemplateUrl(input.templateUrl),
  });
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/update/template?${params.toString()}`;
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
    `1. CFn テンプレ: ${resolveTemplateUrl(input.templateUrl)}`,
    "2. 競技者 AWS account にログインし、 上記 3 値を Parameter として CFn create-stack",
    "3. Quick-create リンク (= 確認画面に pre-fill 済で直接遷移):",
    `   ${buildLaunchStackUrl(input)}`,
    "",
    "完了後 operator にこの mail / msg を返信、 operator が「Verify」 で確認します。",
  ].join("\n");
}

/**
 * #706: 既存 bootstrap stack を最新 template で update してもらう案内 payload。
 * PR-694 (Lambda IAM 追加) のような新 IAM を反映する用途。 競技者に Slack / メールで送る。
 *
 * 既存 stack の Parameter 値は CFn console 側で「Use existing value」 が default になるので、
 * 秘密値 (= ExternalId) を再送する必要は無い (= 公開 URL のみ含める)。
 */
export function buildUpdatePayload(input: UpdateStackUrlInput = {}): string {
  return [
    "TenkaCloud Competitor Bootstrap — 既存 stack の update のお願い",
    "",
    "deploy chain に新しい IAM (例: Lambda Function 操作) が追加されたため、 既に deploy 済の",
    "`tenkacloud-competitor-bootstrap` stack を最新 template に update してください。",
    "",
    "update 手順 (= 1 click):",
    "1. 競技者 AWS account にログイン (= 既存と同じ)",
    "2. 下記 Update Stack リンクを開く (= 既存 stack の Replace current template 画面に直行):",
    `   ${buildUpdateStackUrl(input)}`,
    "3. Parameter 画面は「Use existing value」 のまま (= 秘密値 ExternalId は既存のまま再利用)。",
    "4. 確認画面で diff (= 追加 IAM Statement 等) を確認して Update。",
    "",
    "完了後 operator にこの mail / msg を返信、 operator が「Verify」 で再確認します。",
  ].join("\n");
}
