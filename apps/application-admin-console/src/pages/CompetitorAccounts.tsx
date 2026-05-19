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
  verifyCompetitorAccount,
} from "../api/competitor-accounts-client";
import { CopyableField } from "../components/CopyableField";
import { FriendlyErrorAlert } from "../components/FriendlyErrorAlert";
import type { AppConfig } from "../config";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL,
  isBootstrapUrlMissing,
} from "../lib/competitor-bootstrap";
import { type FriendlyError, toFriendlyError } from "../lib/friendly-error";

const ACCOUNT_ID_RE = /^\d{12}$/;
const ALIAS_MAX = 120;

/**
 * Competitor Accounts 管理画面 (ADR-002 Phase 2.1)。
 *
 * 一覧 / 追加 / Verify / 削除の 4 操作。 ExternalId 更新は 「削除 → アカウントを追加」 の
 * 2 step で完結する (Issue #1089 で仕様簡素化、 旧 Rotate ExternalId 経路は廃止)。
 * `externalId` は **追加直後の modal でのみ** 1 度露出する secret。 verified=false の
 * row は赤、 true は緑。
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
  const [verifyInFlight, setVerifyInFlight] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [showSecret, setShowSecret] = useState<CreateCompetitorAccountResponse | null>(null);

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
            <Button variant="link" onClick={() => setDeleteTarget(item)}>
              削除
            </Button>
          </SpaceBetween>
        ),
      },
    ],
    [handleVerify, verifyInFlight],
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
        description="tenant に紐付ける競技者 AWS account の一覧。 verified=true のみ deploy 可能です。 ExternalId を更新したい場合は対象 account を削除 → 再追加してください (= 仕様簡素化)。"
        actions={
          <Button variant="primary" onClick={() => setAddModalVisible(true)}>
            アカウントを追加
          </Button>
        }
      >
        Competitor Accounts
      </Header>

      {isBootstrapUrlMissing(config.competitorBootstrapTemplateUrl) && (
        <Alert type="warning" header="Bootstrap template URL が未注入です">
          runtime-config の <code>competitorBootstrapTemplateUrl</code> が空のため、 Launch Stack
          リンクは AWS CloudFormation 側で reject されます。 deploy 経路の設定を管理者に
          ご確認ください。
        </Alert>
      )}

      {error && <FriendlyErrorAlert error={error} />}

      <Table
        items={items ?? []}
        columnDefinitions={columnDefinitions}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            まだ Competitor Account が登録されていません。 「アカウントを追加」
            から開始してください。
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
        secret={showSecret}
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
          この操作で tenant に残る最後の row だった場合は、 SSM の ExternalId も同時に削除されます
          (= 鍵漏洩リスク削減)。 ExternalId を更新したい場合も、 削除後に 「アカウントを追加」
          で新規 ExternalId が払い出されます。
        </p>
      </Modal>
    </SpaceBetween>
  );
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
  secret: CreateCompetitorAccountResponse | null;
  onDismiss: () => void;
  /** runtime-config 由来の public S3 URL (= CFn TemplateURL に渡す)。 未注入なら fallback。 */
  templateUrl?: string;
}

/**
 * 競技者と共有する ExternalId 等の secret を提示する modal。 アカウント追加直後に
 * 1 度だけ表示。 Launch Stack (= Quick Create deeplink) で 1 click deploy 可能。
 *
 * ExternalId 更新は 「削除 → 追加」 の 2 step に統一済 (Issue #1089)。
 */
function SecretRevealModal({ secret, onDismiss, templateUrl }: SecretRevealModalProps) {
  const [allCopied, setAllCopied] = useState(false);
  if (!secret) return null;
  const effectiveTemplateUrl =
    templateUrl && templateUrl.length > 0 ? templateUrl : COMPETITOR_BOOTSTRAP_TEMPLATE_URL;
  const payload = buildShareablePayload({
    tenkaCloudAccountId: secret.tenkaCloudAccountId,
    externalId: secret.externalId,
    competitorRoleName: secret.competitorRoleName,
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
          ExternalId は SecureString として保存されており、 閉じると再表示できません。
          競技者に渡すコピーは <strong>今</strong> 取ってください。
        </Alert>
        <SpaceBetween size="s">
          <Header variant="h3">推奨: Launch Stack 1 click deploy</Header>
          <Button
            variant="primary"
            href={buildLaunchStackUrl({
              tenkaCloudAccountId: secret.tenkaCloudAccountId,
              externalId: secret.externalId,
              competitorRoleName: secret.competitorRoleName,
              templateUrl,
            })}
            target="_blank"
            iconName="external"
            iconAlign="right"
          >
            Launch Stack (Quick-create deeplink)
          </Button>
          <Box variant="small" color="text-status-inactive">
            CFn create-stack 画面に直行し、 Parameter 3 値は pre-fill 済です。
          </Box>
        </SpaceBetween>
        <SpaceBetween size="s">
          <Header variant="h3">コピー用</Header>
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
            <li>deploy 完了後、 この画面の 「Verify」 button で接続確認する</li>
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
                  value={secret.tenkaCloudAccountId}
                  ariaLabel="Copy TenkaCloudAccountId"
                />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  ExternalId (= CFn Parameter <code>ExternalId</code>)
                </Box>
                <CopyableField value={secret.externalId} ariaLabel="Copy ExternalId" />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  Competitor Role 名 (= CFn Parameter <code>RoleName</code>)
                </Box>
                <CopyableField value={secret.competitorRoleName} ariaLabel="Copy RoleName" />
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
