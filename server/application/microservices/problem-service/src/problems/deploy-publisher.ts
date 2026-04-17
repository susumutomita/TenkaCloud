/**
 * Problem Deploy Publisher
 *
 * GameDay 問題デプロイイベントを EventBridge に publish する。
 * ローカル開発では inline モードで直接 deployProblem を呼び出す。
 */

import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  EventBusName,
  EventDetailType,
  EventSource,
  type ProblemDeployRequestedDetail,
} from '@tenkacloud/events';

export type ProblemDeployDeliveryMode = 'eventbridge' | 'inline';

type InlineDeployRunner = (
  detail: ProblemDeployRequestedDetail,
) => Promise<void>;

interface ProblemDeployPublisherOptions {
  eventBridgeClient?: EventBridgeClient;
  eventBusName?: string;
  deliveryMode?: ProblemDeployDeliveryMode;
  inlineRunner?: InlineDeployRunner;
}

function resolveDeliveryMode(): ProblemDeployDeliveryMode {
  const configuredMode = process.env.PROBLEM_DEPLOY_DELIVERY_MODE;
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

async function runInlineDeployFlow(
  detail: ProblemDeployRequestedDetail,
): Promise<void> {
  const { deployProblem } = await import(
    '../../../../../lib/handlers/deploy-problem.ts'
  );

  const result = await deployProblem({
    problemId: detail.problemId,
    teamId: detail.teamId,
    tenantId: detail.tenantId,
    targetRoleArn: detail.targetRoleArn,
    externalId: detail.externalId,
    templateUrl: detail.templateUrl,
    appName: 'tenkacloud',
  });

  if (result.deployStatus !== 'completed') {
    throw new Error(
      `Problem deployment failed for problem ${detail.problemId} team ${detail.teamId}`,
    );
  }
}

export class ProblemDeployPublisher {
  private readonly eventBridgeClient: EventBridgeClient;
  private readonly eventBusName: string;
  private readonly deliveryMode: ProblemDeployDeliveryMode;
  private readonly inlineRunner: InlineDeployRunner;

  constructor(options: ProblemDeployPublisherOptions = {}) {
    this.eventBridgeClient =
      options.eventBridgeClient ??
      new EventBridgeClient({
        ...(process.env.AWS_ENDPOINT_URL
          ? { endpoint: process.env.AWS_ENDPOINT_URL }
          : {}),
      });
    this.eventBusName =
      options.eventBusName ??
      process.env.PROBLEM_DEPLOY_EVENT_BUS_NAME ??
      process.env.EVENT_BUS_NAME ??
      EventBusName.DEFAULT;
    this.deliveryMode = options.deliveryMode ?? resolveDeliveryMode();
    this.inlineRunner = options.inlineRunner ?? runInlineDeployFlow;
  }

  async publishDeployRequested(
    detail: ProblemDeployRequestedDetail,
  ): Promise<void> {
    if (this.deliveryMode === 'inline') {
      await this.inlineRunner(detail);
      return;
    }

    const response = await this.eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: EventSource.PROBLEM_SERVICE,
            DetailType: EventDetailType.PROBLEM_DEPLOY_REQUESTED,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );

    if ((response.FailedEntryCount ?? 0) > 0) {
      const failedEntry = response.Entries?.find((entry) => entry.ErrorCode);
      throw new Error(
        `Failed to publish problem deploy event: ${failedEntry?.ErrorCode ?? 'UnknownError'} - ${failedEntry?.ErrorMessage ?? 'Unknown error'}`,
      );
    }
  }
}
