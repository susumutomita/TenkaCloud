import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import type { Tenant } from '@tenkacloud/dynamodb';
import {
  EventBusName,
  EventDetailType,
  EventSource,
  type TenantOnboardingDetail,
} from '@tenkacloud/events';

export type TenantProvisioningDeliveryMode = 'eventbridge' | 'inline';

type InlineProvisioningRunner = (
  detail: TenantOnboardingDetail,
) => Promise<void>;

interface TenantProvisioningPublisherOptions {
  eventBridgeClient?: EventBridgeClient;
  eventBusName?: string;
  deliveryMode?: TenantProvisioningDeliveryMode;
  inlineRunner?: InlineProvisioningRunner;
}

function resolveDeliveryMode(): TenantProvisioningDeliveryMode {
  const configuredMode = process.env.PROVISIONING_DELIVERY_MODE;
  if (
    configuredMode === 'inline' &&
    process.env.NODE_ENV !== 'production'
  ) {
    return 'inline';
  }
  if (
    !configuredMode &&
    process.env.NODE_ENV !== 'production' &&
    typeof process.env.AWS_ENDPOINT_URL === 'string' &&
    process.env.AWS_ENDPOINT_URL.includes('localhost')
  ) {
    return 'inline';
  }
  return 'eventbridge';
}

async function runInlineProvisioningFlow(
  detail: TenantOnboardingDetail,
): Promise<void> {
  if (!process.env.DATA_BUCKET_NAME && process.env.AWS_ENDPOINT_URL?.includes('localhost')) {
    process.env.DATA_BUCKET_NAME = 'tenkacloud-local-data';
  }

  const [{ provisionTenant }, { handler: completionHandler }] = await Promise.all(
    [
      import('../../../../application-plane/tenant-provisioner/src/handler.ts'),
      import('../../../../control-plane/provisioning-completion/src/handler.ts'),
    ],
  );

  const provisionedDetail = await provisionTenant(detail);

  await completionHandler(
    {
      version: '0',
      id: crypto.randomUUID(),
      'detail-type': EventDetailType.TENANT_PROVISIONED,
      source: EventSource.APPLICATION_PLANE,
      account: '000000000000',
      time: provisionedDetail.timestamp,
      region: detail.region,
      resources: [],
      detail: provisionedDetail,
    },
    {} as never,
  );

  if (provisionedDetail.status === 'FAILED') {
    throw new Error(provisionedDetail.error ?? 'Tenant provisioning failed');
  }
}

export class TenantProvisioningPublisher {
  private readonly eventBridgeClient: EventBridgeClient;
  private readonly eventBusName: string;
  private readonly deliveryMode: TenantProvisioningDeliveryMode;
  private readonly inlineRunner: InlineProvisioningRunner;

  constructor(
    options: TenantProvisioningPublisherOptions = {},
  ) {
    this.eventBridgeClient =
      options.eventBridgeClient ??
      new EventBridgeClient({
        ...(process.env.AWS_ENDPOINT_URL
          ? { endpoint: process.env.AWS_ENDPOINT_URL }
          : {}),
      });
    this.eventBusName = options.eventBusName ?? process.env.EVENT_BUS_NAME ?? EventBusName.DEFAULT;
    this.deliveryMode = options.deliveryMode ?? resolveDeliveryMode();
    this.inlineRunner = options.inlineRunner ?? runInlineProvisioningFlow;
  }

  async publishTenantOnboarding(tenant: Tenant): Promise<void> {
    const detail: TenantOnboardingDetail = {
      tenantId: tenant.id,
      tenantName: tenant.name,
      slug: tenant.slug,
      tier: tenant.tier,
      adminEmail: tenant.adminEmail,
      isolationModel: tenant.isolationModel,
      region: tenant.region,
      timestamp: new Date().toISOString(),
    };

    if (this.deliveryMode === 'inline') {
      await this.inlineRunner(detail);
      return;
    }

    const response = await this.eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: EventSource.CONTROL_PLANE,
            DetailType: EventDetailType.TENANT_ONBOARDING,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );

    if ((response.FailedEntryCount ?? 0) > 0) {
      const failedEntry = response.Entries?.find((entry) => entry.ErrorCode);
      throw new Error(
        `Failed to publish tenant onboarding event: ${failedEntry?.ErrorCode ?? 'UnknownError'} - ${failedEntry?.ErrorMessage ?? 'Unknown error'}`,
      );
    }
  }
}
