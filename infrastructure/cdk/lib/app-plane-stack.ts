import {
  CoreApplicationPlane,
  TenantLifecycleScriptJobProps,
  EventManager,
  ProvisioningScriptJob,
  DeprovisioningScriptJob,
} from '@cdklabs/sbt-aws';
import { Stack, StackProps } from 'aws-cdk-lib';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Effect, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface AppPlaneStackProps extends StackProps {
  /** ControlPlane の EventBus ARN */
  readonly eventBusArn: string;
}

/**
 * SBT CoreApplicationPlane スタック。
 *
 * EventBridge 経由で ControlPlane と連携し、
 * テナントプロビジョニング/デプロビジョニングのスクリプトジョブを実行する。
 */
export class AppPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: AppPlaneStackProps) {
    super(scope, id, props);

    let eventManager: EventManager;
    if (props.eventBusArn) {
      const eventBus = EventBus.fromEventBusArn(
        this,
        'EventBus',
        props.eventBusArn
      );
      eventManager = new EventManager(this, 'EventManager', {
        eventBus,
      });
    } else {
      eventManager = new EventManager(this, 'EventManager');
    }

    // テナントリソース操作に必要な最小権限ポリシー
    const tenantResourcePolicy = new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: [
            's3:CreateBucket',
            's3:PutBucketPolicy',
            's3:PutBucketTagging',
            's3:PutObject',
            's3:DeleteBucket',
            's3:DeleteObject',
            's3:ListBucket',
          ],
          resources: ['arn:aws:s3:::tenkacloud-*'],
          effect: Effect.ALLOW,
        }),
        new PolicyStatement({
          actions: [
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:GetItem',
            'dynamodb:Query',
          ],
          resources: ['arn:aws:dynamodb:*:*:table/TenkaCloud-*'],
          effect: Effect.ALLOW,
        }),
      ],
    });

    const scriptsDir = path.join(__dirname, '..', 'scripts');

    const provisioningScript = loadScriptOrDefault(
      path.join(scriptsDir, 'provision-tenant.sh'),
      defaultProvisioningScript()
    );

    const deprovisioningScript = loadScriptOrDefault(
      path.join(scriptsDir, 'deprovision-tenant.sh'),
      defaultDeprovisioningScript()
    );

    const provisioningJobProps: TenantLifecycleScriptJobProps = {
      eventManager,
      permissions: tenantResourcePolicy,
      script: provisioningScript,
      environmentStringVariablesFromIncomingEvent: [
        'tenantId',
        'tier',
        'tenantName',
        'email',
      ],
      environmentVariablesToOutgoingEvent: {
        tenantData: [
          'tenantNamespace',
          'tenantDbPrefix',
          'tenantEndpoint',
          'tenantS3Bucket',
        ],
        tenantRegistrationData: ['registrationStatus'],
      },
    };

    const deprovisioningJobProps: TenantLifecycleScriptJobProps = {
      eventManager,
      permissions: tenantResourcePolicy,
      script: deprovisioningScript,
      environmentStringVariablesFromIncomingEvent: ['tenantId', 'tier'],
      environmentVariablesToOutgoingEvent: {
        tenantRegistrationData: ['registrationStatus'],
      },
    };

    const provisioningJob = new ProvisioningScriptJob(
      this,
      'ProvisioningScriptJob',
      provisioningJobProps
    );

    const deprovisioningJob = new DeprovisioningScriptJob(
      this,
      'DeprovisioningScriptJob',
      deprovisioningJobProps
    );

    new CoreApplicationPlane(this, 'CoreApplicationPlane', {
      eventManager,
      scriptJobs: [provisioningJob, deprovisioningJob],
    });
  }
}

function loadScriptOrDefault(
  scriptPath: string,
  defaultScript: string
): string {
  try {
    return fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return defaultScript;
  }
}

function defaultProvisioningScript(): string {
  return `#!/bin/bash
set -euo pipefail

echo "Provisioning tenant: $tenantId (tier: $tier)"

export tenantNamespace="tenant-$tenantId"
export tenantDbPrefix="TENANT#$tenantId"
export tenantEndpoint="$tenantId.tenkacloud.io"
export tenantS3Bucket="tenkacloud-tenant-$tenantId"
export registrationStatus="COMPLETED"

echo "Provisioning completed for tenant: $tenantId"
`;
}

function defaultDeprovisioningScript(): string {
  return `#!/bin/bash
set -euo pipefail

echo "Deprovisioning tenant: $tenantId (tier: $tier)"

export registrationStatus="DELETED"

echo "Deprovisioning completed for tenant: $tenantId"
`;
}
