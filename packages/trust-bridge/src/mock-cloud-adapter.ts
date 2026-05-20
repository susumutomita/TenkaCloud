import {
  type ExchangeContext,
  ExchangeError,
  type ProviderCredential,
  type ProviderId,
  type ProviderTokenExchange,
} from "./provider.js";
import type { VerifiedCloudActionIntent } from "./schema.js";

export type MockDeploymentSignalStatus = "SUCCEEDED";

export interface MockDeploymentSignal {
  readonly status: MockDeploymentSignalStatus;
  readonly actionType: VerifiedCloudActionIntent["action"]["type"];
  readonly engine: VerifiedCloudActionIntent["action"]["engine"];
  readonly requestId: string;
  readonly traceLabel?: string;
}

export interface MockCloudCredential extends ProviderCredential {
  readonly mode: "mock";
  readonly accountRef: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly requestedScopes: readonly string[];
  readonly deploymentSignal: MockDeploymentSignal;
}

export interface MockCloudAdapterOptions {
  /**
   * The provider this mock adapter stands in for. Mock mode is an execution mode,
   * not a new provider id, so the intent target provider remains aws/gcp/etc.
   */
  readonly provider?: ProviderId;
  readonly maxTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface MockCloudExchangeContext extends ExchangeContext {
  readonly traceLabel?: string;
}

/**
 * #1122: offline/local demo adapter for trust-bridge.
 *
 * This adapter never calls a cloud provider. It validates the same provider
 * boundary as production adapters and returns deterministic, clearly fake
 * credentials plus an immediate success signal that callers can use to drive
 * frontend-only or LocalStack-adjacent demos.
 */
export class MockCloudAdapter implements ProviderTokenExchange<MockCloudCredential> {
  readonly provider: ProviderId;
  private readonly maxTtlSeconds: number;
  private readonly now: () => Date;

  constructor(options: MockCloudAdapterOptions = {}) {
    this.provider = options.provider ?? "aws";
    this.maxTtlSeconds = options.maxTtlSeconds ?? 3600;
    this.now = options.now ?? (() => new Date());
  }

  async exchange(
    intent: VerifiedCloudActionIntent,
    context: ExchangeContext,
  ): Promise<MockCloudCredential> {
    if (intent.target.provider !== this.provider) {
      throw new ExchangeError(
        "provider-mismatch",
        `intent target provider is ${intent.target.provider}, not ${this.provider}`,
      );
    }
    if (intent.constraints.ttlSeconds > this.maxTtlSeconds) {
      throw new ExchangeError(
        "ttl-exceeded-provider-limit",
        `MockCloudAdapter maxTtlSeconds is ${this.maxTtlSeconds}, got ${intent.constraints.ttlSeconds}`,
      );
    }

    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + intent.constraints.ttlSeconds * 1000);
    const mockContext = context as MockCloudExchangeContext;
    return {
      provider: this.provider,
      mode: "mock",
      accountRef: intent.target.providerAccountRef,
      region: intent.target.region,
      accessKeyId: `MOCK-${sanitizeTokenPart(intent.requestId)}`,
      secretAccessKey: "mock-secret-not-valid-for-cloud-provider",
      sessionToken: `mock-session-${sanitizeTokenPart(intent.nonce)}`,
      requestedScopes: [...intent.action.requestedScopes],
      deploymentSignal: {
        status: "SUCCEEDED",
        actionType: intent.action.type,
        engine: intent.action.engine,
        requestId: intent.requestId,
        ...(mockContext.traceLabel ? { traceLabel: mockContext.traceLabel } : {}),
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      forRequestId: intent.requestId,
    };
  }
}

function sanitizeTokenPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}
