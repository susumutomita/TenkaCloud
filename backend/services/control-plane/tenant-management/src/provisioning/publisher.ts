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

export class TenantProvisioningPublisher {
  private readonly eventBridgeClient: EventBridgeClient;
  private readonly eventBusName: string;

  constructor(
    eventBridgeClient = new EventBridgeClient({
      ...(process.env.AWS_ENDPOINT_URL
        ? { endpoint: process.env.AWS_ENDPOINT_URL }
        : {}),
    }),
    eventBusName = process.env.EVENT_BUS_NAME ?? EventBusName.DEFAULT,
  ) {
    this.eventBridgeClient = eventBridgeClient;
    this.eventBusName = eventBusName;
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

    const response = await this.eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: EventSource.CONTROL_PLANE,
            DetailType: EventDetailType.TENANT_ONBOARDING,
            Detail: JSON.stringify(detail),
            Time: new Date(),
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
