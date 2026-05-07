import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";

/**
 * 競技アカウントの IAM Role 名 (= operator が `templates/competitor-bootstrap.yaml`
 * 経由で立てる role の固定名)。switch role URL の `roleName` パラメータに使う。
 *
 * 異なる名前で role を作っている operator は CDK env / runtime-config で上書き可能に
 * する余地があるが、現状はテンプレートの default 値で固定。
 */
const COMPETITOR_ROLE_NAME = "TenkaCloudCompetitorBootstrap";

/**
 * 自分の AWS アカウントから competitor role に switch role するための AWS Console URL を組み立てる。
 *
 *   https://signin.aws.amazon.com/switchrole?
 *     account=<accountId>&roleName=<roleName>&displayName=<label>&region=<region>
 *
 * 競技者が **既に AWS Console にログイン済** であれば、URL を開くだけで confirm
 * ダイアログ → role 切替が完了する。ログインしていないと AWS のログインを要求される。
 *
 * フル federation (= operator アカウントから token を発行して 1-click ログイン)
 * は cross-account AssumeRole + ExternalId 管理が必要で MVP-1 にはまだ無い (Issue #500)。
 * 当面はこの switch role URL で代替し、競技者は自身の AWS アカウントからアクセスする。
 */
function buildSwitchRoleUrl(params: {
  accountId: string;
  region: string;
  problemId: string;
  jobId: string;
}): string {
  const display = `TC-${params.problemId}-${params.jobId.slice(0, 8)}`;
  const qs = new URLSearchParams({
    account: params.accountId,
    roleName: COMPETITOR_ROLE_NAME,
    displayName: display,
    region: params.region,
  });
  return `https://signin.aws.amazon.com/switchrole?${qs.toString()}`;
}

export function SsoCredentialsPage({ config }: { config: AppConfig }) {
  const { view, error } = useTeamView();
  const isBackend = config.mode === "backend";

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="自チームに deploy された問題の競技アカウントへ AWS Console から直接アクセスする手段。"
      >
        SSO Credentials
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}

      <Alert type="info" header="使い方">
        <Box variant="p">
          下のボタンは AWS Console の <strong>Switch Role</strong> 画面に飛びます。 先に各自の AWS
          アカウントで{" "}
          <a href="https://signin.aws.amazon.com/" target="_blank" rel="noreferrer noopener">
            AWS Console
          </a>{" "}
          にログインしておいてください (普段使っている個人アカウント /
          会社アカウント等で構いません)。 ログイン後にボタンを押すと、競技用の IAM Role
          に切り替わって対象の問題環境に access できます。
        </Box>
        <Box variant="small" color="text-status-info" padding={{ top: "s" }}>
          ※ ワンクリック federation (= 自前 AWS ログイン不要) は cross-account AssumeRole +
          ExternalId 管理が要るため、後続 PR で実装予定 (Issue #500)。
        </Box>
      </Alert>

      {isBackend && !view && !error && <Box>状態を取得中…</Box>}

      {view && view.problems.length === 0 && (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">問題がありません</Box>
          </Box>
        </Container>
      )}

      {view?.problems
        .filter((p) => p.awsAccountId)
        .map((problem) => {
          const url = buildSwitchRoleUrl({
            accountId: problem.awsAccountId,
            region: problem.region,
            problemId: problem.problemId,
            jobId: problem.jobId,
          });
          return (
            <Container
              key={problem.jobId}
              header={
                <Header
                  variant="h2"
                  actions={
                    <Button
                      variant="primary"
                      iconName="external"
                      ariaLabel={`${problem.problemId} の AWS Console を開く`}
                      onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
                    >
                      AWS Console を開く
                    </Button>
                  }
                >
                  <code>{problem.problemId}</code>
                </Header>
              }
            >
              <KeyValuePairs
                columns={3}
                items={[
                  { label: "AWS Account", value: <code>{problem.awsAccountId}</code> },
                  { label: "Region", value: problem.region },
                  { label: "Switch Role 先", value: <code>{COMPETITOR_ROLE_NAME}</code> },
                ]}
              />
            </Container>
          );
        })}
    </SpaceBetween>
  );
}
