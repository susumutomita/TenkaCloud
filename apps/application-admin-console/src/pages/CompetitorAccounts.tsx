import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiClient } from "../api/client";
import {
  type CompetitorAccountSummary,
  type CreateCompetitorAccountResponse,
  createCompetitorAccount,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  type RotateExternalIdResponse,
  rotateExternalId,
  verifyCompetitorAccount,
} from "../api/competitor-accounts-client";
import { CopyableField } from "../components/CopyableField";
import { FriendlyErrorAlert } from "../components/FriendlyErrorAlert";
import type { AppConfig } from "../config";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  buildUpdatePayload,
  buildUpdateStackUrl,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL,
  isBootstrapUrlMissing,
} from "../lib/competitor-bootstrap";
import { type FriendlyError, toFriendlyError } from "../lib/friendly-error";
import { computeRotationAge, ROTATION_AGE_WARNING_DAYS } from "../lib/rotation-age";

const ACCOUNT_ID_RE = /^\d{12}$/;
const ALIAS_MAX = 120;

/**
 * Competitor Accounts 管理画面 (Issue #459 / ADR-002 Phase 2.1)。
 *
 * 一覧 / 追加 / Verify / 削除の 4 操作。`externalId` は **追加直後の modal でのみ** 1 度
 * 露出 (= 競技者にコピペで渡してもらう secret)。verified=false の row は赤、true は緑。
 *
 * 「Verify」 button は STS AssumeRole sanity check を tenant 側で発行する (= 競技者が
 * `competitor-bootstrap.yaml` を deploy し終えたかを operator がワンクリックで確認)。
 */
export function CompetitorAccountsPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const [items, setItems] = useState<readonly CompetitorAccountSummary[] | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CompetitorAccountSummary | null>(null);
  const [rotateTarget, setRotateTarget] = useState<CompetitorAccountSummary | null>(null);
  const [verifyInFlight, setVerifyInFlight] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [rotateInFlight, setRotateInFlight] = useState(false);
  const [showSecret, setShowSecret] = useState<
    CreateCompetitorAccountResponse | RotateExternalIdResponse | null
  >(null);
  // #706: 既存 bootstrap stack の update 案内 modal (= row の「Update bootstrap」 button から開く)。
  const [updateTarget, setUpdateTarget] = useState<CompetitorAccountSummary | null>(null);

  const reload = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listCompetitorAccounts(apiClient);
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(toFriendlyError(err));
    }
  }, [apiClient]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleVerify = useCallback(
    async (awsAccountId: string) => {
      if (!apiClient) return;
      setVerifyInFlight(awsAccountId);
      try {
        await verifyCompetitorAccount(apiClient, awsAccountId);
        await reload();
      } catch (err) {
        setError(toFriendlyError(err));
      } finally {
        setVerifyInFlight(null);
      }
    },
    [apiClient, reload],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!apiClient || !deleteTarget) return;
    setDeleteInFlight(true);
    try {
      await deleteCompetitorAccount(apiClient, deleteTarget.awsAccountId);
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setDeleteInFlight(false);
    }
  }, [apiClient, deleteTarget, reload]);

  const handleConfirmRotate = useCallback(async () => {
    if (!apiClient || !rotateTarget) return;
    setRotateInFlight(true);
    try {
      const res = await rotateExternalId(apiClient, rotateTarget.awsAccountId);
      setRotateTarget(null);
      setShowSecret(res);
      await reload();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setRotateInFlight(false);
    }
  }, [apiClient, rotateTarget, reload]);

  // 一覧 mount 時の wall clock。re-render ごとに揺らがないよう state 化する
  // (= 1 秒未満の差で age 表示が点滅するのを防ぐ)。
  const [nowMs] = useState(() => Date.now());

  const columnDefinitions = useMemo<TableProps.ColumnDefinition<CompetitorAccountSummary>[]>(
    () => [
      {
        id: "awsAccountId",
        header: "AWS Account ID",
        cell: (item) => <code>{item.awsAccountId}</code>,
      },
      {
        id: "alias",
        header: "Alias",
        cell: (item) => item.alias ?? <Box color="text-status-inactive">(未設定)</Box>,
      },
      {
        id: "region",
        header: "Region",
        cell: (item) => <code>{item.region}</code>,
      },
      {
        id: "competitorRoleName",
        header: "IAM Role 名",
        cell: (item) => <code>{item.competitorRoleName}</code>,
      },
      {
        id: "verified",
        header: "状態",
        cell: (item) =>
          item.verified ? (
            <Badge color="green">Verified</Badge>
          ) : (
            <Badge color="red">Unverified</Badge>
          ),
      },
      {
        id: "rotationAge",
        header: "Rotation 経過",
        cell: (item) => <RotationAgeBadge item={item} nowMs={nowMs} />,
      },
      {
        id: "actions",
        header: "操作",
        cell: (item) => (
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              loading={verifyInFlight === item.awsAccountId}
              disabled={verifyInFlight !== null}
              onClick={() => handleVerify(item.awsAccountId)}
            >
              {item.verified ? "再 Verify" : "Verify"}
            </Button>
            <Button
              variant="normal"
              iconName="refresh"
              onClick={() => setRotateTarget(item)}
              data-testid={`rotate-${item.awsAccountId}`}
            >
              Rotate ExternalId
            </Button>
            <Button
              variant="normal"
              iconName="upload"
              onClick={() => setUpdateTarget(item)}
              data-testid={`update-bootstrap-${item.awsAccountId}`}
            >
              Update bootstrap
            </Button>
            <Button variant="link" onClick={() => setDeleteTarget(item)}>
              削除
            </Button>
          </SpaceBetween>
        ),
      },
    ],
    [handleVerify, verifyInFlight, nowMs],
  );

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 一覧を取得中...
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="tenant に紐付ける競技者 AWS account の一覧。verified=true のみ deploy 可能です。"
        actions={
          <Button variant="primary" onClick={() => setAddModalVisible(true)}>
            アカウントを追加
          </Button>
        }
      >
        Competitor Accounts
      </Header>

      {/* Issue #1055: runtime-config に competitorBootstrapTemplateUrl が注入されていないと
          Launch / Update Stack リンクが GitHub raw URL fallback を返し、 AWS CFn console で
          「TemplateURL must be a supported URL」 で reject される。 操作前に operator へ事前告知。
          根治は #1053 で hosting を ProblemDeployBackendStack に移管したのち本 banner は撤去予定。 */}
      {isBootstrapUrlMissing(config.competitorBootstrapTemplateUrl) && (
        <Alert type="warning" header="Bootstrap template URL が未注入です">
          runtime-config の <code>competitorBootstrapTemplateUrl</code> が空のため、 Launch / Update
          Stack リンクは AWS CloudFormation 側で reject されます。 deploy 経路の
          設定を管理者にご確認ください (= 参考: #1053)。
        </Alert>
      )}

      {error && <FriendlyErrorAlert error={error} />}

      <Table
        items={items ?? []}
        columnDefinitions={columnDefinitions}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            まだ Competitor Account が登録されていません。「アカウントを追加」から開始してください。
          </Box>
        }
      />

      <AddAccountModal
        config={config}
        visible={addModalVisible}
        onDismiss={() => setAddModalVisible(false)}
        onSuccess={(res) => {
          setAddModalVisible(false);
          setShowSecret(res);
          void reload();
        }}
      />

      <SecretRevealModal
        details={showSecret}
        onDismiss={() => setShowSecret(null)}
        templateUrl={config.competitorBootstrapTemplateUrl}
      />

      <Modal
        visible={deleteTarget !== null}
        onDismiss={() => setDeleteTarget(null)}
        header="アカウントを削除"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleteTarget(null)} disabled={deleteInFlight}>
                キャンセル
              </Button>
              <Button variant="primary" loading={deleteInFlight} onClick={handleConfirmDelete}>
                削除する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <p>
          AWS Account <code>{deleteTarget?.awsAccountId}</code> を tenant から外しますか？
        </p>
        <p>
          この操作で tenant に残る最後の row だった場合は、SSM の ExternalId も同時に削除されます (=
          鍵漏洩リスク削減)。
        </p>
      </Modal>

      <BootstrapUpdateModal
        target={updateTarget}
        onDismiss={() => setUpdateTarget(null)}
        templateUrl={config.competitorBootstrapTemplateUrl}
      />

      <Modal
        visible={rotateTarget !== null}
        onDismiss={() => (rotateInFlight ? undefined : setRotateTarget(null))}
        header="ExternalId を rotate"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setRotateTarget(null)} disabled={rotateInFlight}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                loading={rotateInFlight}
                onClick={handleConfirmRotate}
                data-testid="rotate-confirm"
              >
                Rotate する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Alert type="warning" header="現在の ExternalId は即時失効します">
          AWS Account <code>{rotateTarget?.awsAccountId}</code> に紐付く tenant の ExternalId
          を新値で 上書きします。この操作後、競技者は <code>competitor-bootstrap.yaml</code> stack
          の Parameter を <strong>新 ExternalId</strong> で update する必要があります (= 古い値での
          AssumeRole は 失敗するようになります)。
        </Alert>
        <p>
          同 tenant 配下の他 account も同じ ExternalId を共有するため、tenant に複数 account が
          登録されている場合は <strong>全 competitor に新値を共有</strong>してください。
        </p>
      </Modal>
    </SpaceBetween>
  );
}

interface RotationAgeBadgeProps {
  item: CompetitorAccountSummary;
  nowMs: number;
}

function RotationAgeBadge({ item, nowMs }: RotationAgeBadgeProps) {
  const age = computeRotationAge({
    createdAt: item.createdAt,
    rotatedAt: item.rotatedAt,
    nowMs,
  });
  const label = age.hasRotated
    ? `${age.ageDays} 日前 rotate`
    : `${age.ageDays} 日前作成 (未 rotate)`;
  if (age.isStale) {
    return (
      <Badge color="severity-medium">
        {label} (要 rotation: {ROTATION_AGE_WARNING_DAYS} 日超)
      </Badge>
    );
  }
  return <Box color="text-status-inactive">{label}</Box>;
}

interface AddAccountModalProps {
  config: AppConfig;
  visible: boolean;
  onDismiss: () => void;
  onSuccess: (res: CreateCompetitorAccountResponse) => void;
}

function AddAccountModal({ config, visible, onDismiss, onSuccess }: AddAccountModalProps) {
  const apiClient = useApiClient(config);
  const [awsAccountId, setAwsAccountId] = useState("");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState("ap-northeast-1");
  const [competitorRoleName, setCompetitorRoleName] = useState("TenkaCloud-CompetitorDeploy-Role");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const reset = () => {
    setAwsAccountId("");
    setAlias("");
    setRegion("ap-northeast-1");
    setCompetitorRoleName("TenkaCloud-CompetitorDeploy-Role");
    setError(null);
  };

  const handleDismiss = () => {
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const awsAccountIdInvalid = awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(awsAccountId);
  const aliasInvalid = alias.length > ALIAS_MAX;
  const submitDisabled =
    !apiClient || inFlight || awsAccountId.length === 0 || awsAccountIdInvalid || aliasInvalid;

  const handleSubmit = async () => {
    if (!apiClient || submitDisabled) return;
    setInFlight(true);
    setError(null);
    try {
      const res = await createCompetitorAccount(apiClient, {
        awsAccountId,
        region,
        competitorRoleName,
        ...(alias.length > 0 ? { alias } : {}),
      });
      reset();
      onSuccess(res);
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setInFlight(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={handleDismiss}
      header="Competitor Account を追加"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleDismiss} disabled={inFlight}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              loading={inFlight}
              disabled={submitDisabled}
              onClick={handleSubmit}
            >
              追加
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && <FriendlyErrorAlert error={error} />}
        <FormField
          label="AWS Account ID"
          description="12 桁の数字"
          errorText={awsAccountIdInvalid ? "12 桁の数字で入力してください" : undefined}
        >
          <Input
            value={awsAccountId}
            onChange={(e) => setAwsAccountId(e.detail.value)}
            invalid={awsAccountIdInvalid}
            placeholder="123456789012"
            disabled={inFlight}
          />
        </FormField>
        <FormField label="Alias (任意)" description="operator 表示用ラベル">
          <Input
            value={alias}
            onChange={(e) => setAlias(e.detail.value)}
            invalid={aliasInvalid}
            placeholder="Team Acme prod"
            disabled={inFlight}
          />
        </FormField>
        <FormField label="Region" description="deploy 先 region (default: ap-northeast-1)">
          <Input value={region} onChange={(e) => setRegion(e.detail.value)} disabled={inFlight} />
        </FormField>
        <FormField
          label="IAM Role 名"
          description="競技者側 bootstrap で deploy する Role 名 (default: TenkaCloud-CompetitorDeploy-Role)"
        >
          <Input
            value={competitorRoleName}
            onChange={(e) => setCompetitorRoleName(e.detail.value)}
            disabled={inFlight}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

interface SecretRevealModalProps {
  details: CreateCompetitorAccountResponse | RotateExternalIdResponse | null;
  onDismiss: () => void;
  /** #718: runtime-config 由来の public S3 URL (= CFn TemplateURL に渡す)。未注入なら GitHub raw fallback。 */
  templateUrl?: string;
}

function SecretRevealModal({ details, onDismiss, templateUrl }: SecretRevealModalProps) {
  const [allCopied, setAllCopied] = useState(false);
  if (!details) return null;
  const launchStackUrl = buildLaunchStackUrl({
    tenkaCloudAccountId: details.tenkaCloudAccountId,
    externalId: details.externalId,
    competitorRoleName: details.competitorRoleName,
    templateUrl,
  });
  const effectiveTemplateUrl =
    templateUrl && templateUrl.length > 0 ? templateUrl : COMPETITOR_BOOTSTRAP_TEMPLATE_URL;
  const payload = buildShareablePayload({
    tenkaCloudAccountId: details.tenkaCloudAccountId,
    externalId: details.externalId,
    competitorRoleName: details.competitorRoleName,
    templateUrl,
  });
  const onCopyAll = async () => {
    await navigator.clipboard.writeText(payload);
    setAllCopied(true);
    setTimeout(() => setAllCopied(false), 2000);
  };
  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header="競技者に共有する情報"
      footer={
        <Box float="right">
          <Button variant="primary" onClick={onDismiss}>
            閉じる
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="warning" header="この画面でのみ ExternalId を確認できます">
          ExternalId は SecureString として保存されており、閉じると再表示できません。
          競技者に渡すコピーは <strong>今</strong> 取ってください。
        </Alert>
        <SpaceBetween size="s">
          <Header variant="h3">推奨: Launch Stack 1 click deploy</Header>
          <Button
            variant="primary"
            href={launchStackUrl}
            target="_blank"
            iconName="external"
            iconAlign="right"
          >
            Launch Stack (Quick-create deeplink)
          </Button>
          <Box variant="small" color="text-status-inactive">
            CFn create-stack 画面に直行し、Parameter 3 値は pre-fill 済です。
          </Box>
        </SpaceBetween>
        <SpaceBetween size="s">
          <Header variant="h3">競技者に共有する情報</Header>
          <Button
            iconName={allCopied ? "status-positive" : "copy"}
            onClick={() => void onCopyAll()}
          >
            {allCopied ? "コピーしました" : "すべて (3 値 + 手順 + Launch Stack URL) をコピー"}
          </Button>
        </SpaceBetween>
        <div>
          <Box variant="awsui-key-label">次のステップ — 競技者向け</Box>
          <ol>
            <li>Launch Stack を開いて bootstrap stack を作成する</li>
            <li>deploy 完了後、 この画面の「Verify」 button で接続確認する</li>
          </ol>
        </div>
        <ExpandableSection headerText="手動 deploy の詳細" variant="container">
          <SpaceBetween size="m">
            <ColumnLayout columns={1} variant="text-grid">
              <div>
                <Box variant="awsui-key-label">
                  TenkaCloud Account ID (= CFn Parameter <code>TenkaCloudAccountId</code>)
                </Box>
                <CopyableField
                  value={details.tenkaCloudAccountId}
                  ariaLabel="Copy TenkaCloudAccountId"
                />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  ExternalId (= CFn Parameter <code>ExternalId</code>)
                </Box>
                <CopyableField value={details.externalId} ariaLabel="Copy ExternalId" />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  Competitor Role 名 (= CFn Parameter <code>RoleName</code>)
                </Box>
                <CopyableField value={details.competitorRoleName} ariaLabel="Copy RoleName" />
              </div>
              <div>
                <Box variant="awsui-key-label">CFn template</Box>
                <a href={effectiveTemplateUrl} target="_blank" rel="noreferrer noopener">
                  competitor-bootstrap.yaml (raw)
                </a>
              </div>
            </ColumnLayout>
            <Box variant="small" color="text-status-inactive">
              上記 3 値を Parameter として CloudFormation create-stack でも deploy できます。
            </Box>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Modal>
  );
}

interface BootstrapUpdateModalProps {
  target: CompetitorAccountSummary | null;
  onDismiss: () => void;
  /** #718: runtime-config 由来の public S3 URL (= CFn TemplateURL に渡す)。未注入なら GitHub raw fallback。 */
  templateUrl?: string;
}

/**
 * #706: 既存 bootstrap stack の update 案内 modal。
 *
 * PR-694 (Lambda IAM 追加) のように deploy chain 側で IAM が増えると、 競技者の
 * `tenkacloud-competitor-bootstrap` stack を最新 template で update してもらわないと
 * 「lambda:GetFunction AccessDenied」 等で deploy が失敗する。
 *
 * 本 modal は秘密値 (ExternalId) を含まないので、 既存 row から呼べる (= row には
 * externalId が無い)。 競技者の CFn console で Parameter は default で existing value 再利用される。
 */
function BootstrapUpdateModal({ target, onDismiss, templateUrl }: BootstrapUpdateModalProps) {
  const [copied, setCopied] = useState(false);
  if (!target) return null;
  const updateUrl = buildUpdateStackUrl({ region: target.region, templateUrl });
  const payload = buildUpdatePayload({ region: target.region, templateUrl });
  const onCopy = async () => {
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header="bootstrap stack の update を依頼"
      footer={
        <Box float="right">
          <Button variant="primary" onClick={onDismiss}>
            閉じる
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="info" header="新しい IAM 反映には bootstrap stack の update が必要です">
          deploy chain 側で IAM (例: Lambda 操作権限) が追加された場合、 competitor 側で
          <code>tenkacloud-competitor-bootstrap</code> stack を最新 template に update して
          もらう必要があります。 ExternalId 等の秘密値は競技者の既存 stack で再利用されるため、
          operator から再送する必要はありません。
        </Alert>
        <Box>
          <Button
            variant="primary"
            iconName={copied ? "status-positive" : "copy"}
            onClick={() => void onCopy()}
            data-testid="copy-update-payload"
          >
            {copied ? "コピーしました" : "update 依頼テキストをコピー (Slack / メール用)"}
          </Button>
        </Box>
        <div>
          <Box variant="awsui-key-label">Update Stack URL (= 競技者がワンクリックで開く)</Box>
          <CopyableField value={updateUrl} ariaLabel="Copy Update Stack URL" />
        </div>
        <div>
          <Box variant="awsui-key-label">最新 template (= レビュー用 raw URL)</Box>
          <CopyableField
            value={COMPETITOR_BOOTSTRAP_TEMPLATE_URL}
            ariaLabel="Copy bootstrap template URL"
          />
        </div>
        <Box variant="small" color="text-status-inactive">
          競技者は SSO ログイン後、 Replace current template 画面に直行します。 Parameter 値は 「Use
          existing value」 (= default) のままで OK。 confirm 画面で IAM diff (例: lambda:GetFunction
          追加) を確認して Update。
        </Box>
      </SpaceBetween>
    </Modal>
  );
}
