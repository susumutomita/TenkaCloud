import { resolve } from "node:path";
import {
  BashJobRunner,
  type BashJobRunnerProps,
  CoreApplicationPlane,
  DetailType,
  EventManager,
} from "@cdklabs/sbt-aws";
import { Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import type { Construct } from "constructs";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names.js";
import { TenantStatusReconciler } from "../tenant-status-reconciler/tenant-status-reconciler.js";
import { composeTenantScript } from "./compose-tenant-script.js";
import { buildTenantJobRunnerPermissions } from "./job-runner-permissions.js";
import { TenantApiKey } from "./tenant-api-key.js";

interface BootstrapTemplateStackProps extends StackProps {
  apiKeySSMParameterNames: ApiKeySSMParameterNames;
  apiKeyPlatinumTierParameter: string;
  apiKeyPremiumTierParameter: string;
  apiKeyStandardTierParameter: string;
  apiKeyBasicTierParameter: string;
  eventBusArn: string;
  systemAdminEmail: string;
  /**
   * #2194: the resolved (per-environment) source-bundle S3 bucket name the deploy
   * created (`CDK_PARAM_S3_BUCKET_NAME`). Injected into the provision/deprovision
   * ScriptJob environment so they read the exact bucket instead of recomputing a
   * divergent name.
   */
  sourceBucketName: string;
  /**
   * TenantMappingTable の billing mode。`PROVISIONED` (default) のときは
   * `tenantMappingTableReadCapacity` / `tenantMappingTableWriteCapacity` を使う。
   * `PAY_PER_REQUEST` のときは capacity 指定は無視される。
   */
  tenantMappingTableBillingMode?: BillingMode;
  /**
   * TenantMappingTable の DynamoDB プロビジョンドキャパシティ (読込)。
   * 未指定時は 1。dev / 小規模運用では 1 で十分。`PAY_PER_REQUEST` 時は無視される。
   */
  tenantMappingTableReadCapacity?: number;
  /** TenantMappingTable の DynamoDB プロビジョンドキャパシティ (書込)。未指定時は 1。 */
  tenantMappingTableWriteCapacity?: number;
}

export class BootstrapTemplateStack extends Stack {
  public readonly tenantMappingTable: Table;
  /**
   * Issue #814 Phase 2: SBT BashJobRunner が立てる deprovisioning state machine の ARN。
   * admin-insight Lambda が \`states:ListExecutions\` で実行履歴を取得し、 admin-console の
   * 「Deprovisioning Jobs」 タブで参加者運営に見せるために cross-stack 参照する。
   */
  public readonly deprovisioningStateMachineArn: string;

  constructor(scope: Construct, id: string, props: BootstrapTemplateStackProps) {
    super(scope, id, props);

    const systemAdminEmail = props.systemAdminEmail;
    const sourceBucketName = props.sourceBucketName;
    const eventBusArn = props.eventBusArn;

    const eventBus = EventBus.fromEventBusArn(this, "EventBus", eventBusArn);
    const eventManager = new EventManager(this, "EventManager", {
      eventBus: eventBus,
    });
    const billingMode = props.tenantMappingTableBillingMode ?? BillingMode.PROVISIONED;
    this.tenantMappingTable = new Table(this, "TenantMappingTable", {
      partitionKey: { name: "tenantId", type: AttributeType.STRING },
      billingMode,
      // capacity は PROVISIONED のときだけ指定 (PAY_PER_REQUEST と同時指定は CDK でエラー)
      ...(billingMode === BillingMode.PROVISIONED
        ? {
            readCapacity: props.tenantMappingTableReadCapacity ?? 1,
            writeCapacity: props.tenantMappingTableWriteCapacity ?? 1,
          }
        : {}),
    });

    // #1382: SBT reference-arch の BashJobRunner は example で `Action:* Resource:*` を渡すが、
    // TenkaCloud の provision/deprovision script が実際に必要とする最小権限へ絞る
    // (= SBT construct 自体は不変、 渡す permissions のみ TenkaCloud 固有に scope)。 詳細・前提は
    // buildTenantJobRunnerPermissions の docblock 参照。 cross-account 化 (#857) で更に縮む。
    const jobRunnerPermissions = buildTenantJobRunnerPermissions(this.account, this.region);

    const provisioningJobRunnerProps: BashJobRunnerProps = {
      eventManager: eventManager,
      permissions: jobRunnerPermissions,
      script: composeTenantScript(
        resolve(import.meta.dirname, "../../../scripts/provision-tenant.sh"),
      ),
      postScript: "",
      environmentStringVariablesFromIncomingEvent: ["tenantId", "tier", "tenantName", "email"],
      environmentVariablesToOutgoingEvent: [
        "tenantConfig",
        "tenantStatus",
        "prices", // added so we don't lose it for targets beyond provisioning (ex. billing)
        "tenantName", // added so we don't lose it for targets beyond provisioning (ex. billing)
        "email", // added so we don't lose it for targets beyond provisioning (ex. billing)
      ],
      scriptEnvironmentVariables: {
        // CDK_PARAM_SYSTEM_ADMIN_EMAIL is required because as part of deploying the bootstrap-template
        // the control plane is also deployed. To ensure the operation does not error out, this value
        // is provided as an env parameter.
        CDK_PARAM_SYSTEM_ADMIN_EMAIL: systemAdminEmail,
        // #2194: the exact source bucket the deploy created, so provision-tenant.sh
        // reads it directly instead of recomputing a divergent (no-hash) name.
        CDK_PARAM_S3_BUCKET_NAME: sourceBucketName,
      },
      outgoingEvent: DetailType.PROVISION_SUCCESS,
      incomingEvent: DetailType.ONBOARDING_REQUEST,
    };

    // #1382: provisioning と同じ least-privilege scope を共有する (deprovision は cdk destroy +
    // tenant user/group の削除なので、 provisioning の superset で過不足ない)。
    const deprovisioningJobRunnerProps: BashJobRunnerProps = {
      eventManager: eventManager,
      permissions: jobRunnerPermissions,
      script: composeTenantScript(
        resolve(import.meta.dirname, "../../../scripts/deprovision-tenant.sh"),
      ),
      environmentStringVariablesFromIncomingEvent: ["tenantId"],
      environmentVariablesToOutgoingEvent: ["tenantStatus"],
      outgoingEvent: DetailType.DEPROVISION_SUCCESS,
      incomingEvent: DetailType.OFFBOARDING_REQUEST,
      scriptEnvironmentVariables: {
        TENANT_STACK_MAPPING_TABLE: this.tenantMappingTable.tableName,
        // CDK_PARAM_SYSTEM_ADMIN_EMAIL is required because as part of deploying the bootstrap-template
        // the control plane is also deployed. To ensure the operation does not error out, this value
        // is provided as an env parameter.
        CDK_PARAM_SYSTEM_ADMIN_EMAIL: systemAdminEmail,
        // #2194: the exact source bucket the deploy created, so deprovision-tenant.sh
        // reads it directly instead of recomputing a divergent (no-hash) name.
        CDK_PARAM_S3_BUCKET_NAME: sourceBucketName,
      },
    };

    const provisioningJobRunner: BashJobRunner = new BashJobRunner(
      this,
      "provisioningJobRunner",
      provisioningJobRunnerProps,
    );
    const deprovisioningJobRunner: BashJobRunner = new BashJobRunner(
      this,
      "deprovisioningJobRunner",
      deprovisioningJobRunnerProps,
    );

    // Issue #814 Phase 2: deprovisioning Step Functions SM ARN を public export し、
    // admin-insight Lambda が ListExecutions で執行履歴を引けるようにする。
    this.deprovisioningStateMachineArn =
      deprovisioningJobRunner.provisioningStateMachine.stateMachineArn;

    new CoreApplicationPlane(this, "CoreApplicationPlane", {
      eventManager: eventManager,
      jobRunnersList: [provisioningJobRunner, deprovisioningJobRunner],
    });

    // #1384: TenantApiKey は API キー値を平文で受け取らない (API Gateway が auto-generate)。
    // keyId / valueName のパラメータ名のみ渡す。
    new TenantApiKey(this, "BasicTierApiKey", {
      ssmParameterApiKeyIdName: props.apiKeySSMParameterNames.basic.keyId,
      ssmParameterApiValueName: props.apiKeySSMParameterNames.basic.value,
    });

    new TenantApiKey(this, "StandardTierApiKey", {
      ssmParameterApiKeyIdName: props.apiKeySSMParameterNames.standard.keyId,
      ssmParameterApiValueName: props.apiKeySSMParameterNames.standard.value,
    });

    new TenantApiKey(this, "PremiumTierApiKey", {
      ssmParameterApiKeyIdName: props.apiKeySSMParameterNames.premium.keyId,
      ssmParameterApiValueName: props.apiKeySSMParameterNames.premium.value,
    });

    new TenantApiKey(this, "PlatinumTierApiKey", {
      ssmParameterApiKeyIdName: props.apiKeySSMParameterNames.platinum.keyId,
      ssmParameterApiValueName: props.apiKeySSMParameterNames.platinum.value,
    });

    // Issue #659: 2 分周期で TenantMappingTable を scan し、 provision-tenant.sh の
    // 結果 (tenantConfig 充足 / 経過時間) で "In progress" stuck な行を "Complete" /
    // "Failed" に自動遷移させる。
    new TenantStatusReconciler(this, "TenantStatusReconciler", {
      tenantMappingTable: this.tenantMappingTable,
    });
  }
}
