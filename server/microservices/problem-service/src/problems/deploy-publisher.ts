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
  /**
   * inline mode で実行する deploy flow。dev で LocalStack を使うときだけ caller が DI 想定。
   * 指定が無いまま inline mode になった場合は実行時にエラー (PR #398/ADR-014 で旧 lib/handlers
   * path が消えたため、default の dynamic import は撤去)。
   */
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

export class ProblemDeployPublisher {
  private readonly eventBridgeClient: EventBridgeClient;
  private readonly eventBusName: string;
  private readonly deliveryMode: ProblemDeployDeliveryMode;
  private readonly inlineRunner: InlineDeployRunner | undefined;

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
    this.inlineRunner = options.inlineRunner;
  }

  async publishDeployRequested(
    detail: ProblemDeployRequestedDetail,
  ): Promise<void> {
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
