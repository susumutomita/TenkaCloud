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
  /**
   * inline mode で実行する provisioning flow。dev 環境で LocalStack 等を使うときだけ
   * caller が DI する想定。指定が無いまま inline mode になった場合は実行時にエラー。
   * (PR #398/ADR-014 で旧 application-plane/tenant-provisioner 等の path が消えたため、
   *  default の dynamic import は撤去した。)
   */
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

export class TenantProvisioningPublisher {
  private readonly eventBridgeClient: EventBridgeClient;
  private readonly eventBusName: string;
  private readonly deliveryMode: TenantProvisioningDeliveryMode;
  private readonly inlineRunner: InlineProvisioningRunner | undefined;

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
    this.inlineRunner = options.inlineRunner;
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
      if (!this.inlineRunner) {
        throw new Error(
          'inline delivery mode requires an inlineRunner option (dynamic import default was removed; provide a runner explicitly in dev setup).',
        );
      }
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
