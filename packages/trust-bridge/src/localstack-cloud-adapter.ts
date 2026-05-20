import {
  type ExchangeContext,
  ExchangeError,
  type ProviderCredential,
  type ProviderTokenExchange,
} from "./provider.js";
import type { VerifiedCloudActionIntent } from "./schema.js";

const DEFAULT_LOCALSTACK_ENDPOINT = "http://localhost:4566";

export interface LocalStackCredential extends ProviderCredential {
  readonly provider: "aws";
  readonly mode: "localstack";
  readonly endpointUrl: string;
  readonly accountRef: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly requestedScopes: readonly string[];
  readonly traceLabel?: string;
}

export interface LocalStackCloudAdapterOptions {
  readonly endpointUrl?: string;
  readonly region?: string;
  readonly maxTtlSeconds?: number;
  readonly now?: () => Date;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
}

export interface LocalStackExchangeContext extends ExchangeContext {
  readonly endpointUrl?: string;
  readonly traceLabel?: string;
}

/**
 * This adapter does not call AWS or LocalStack. It validates the intent boundary
 * and returns endpoint-aware AWS-shaped credentials that consumers can pass to
 * SDK clients configured with the returned `endpointUrl`.
 */
export class LocalStackCloudAdapter implements ProviderTokenExchange<LocalStackCredential> {
  readonly provider = "aws" as const;
  private readonly endpointUrl: string;
  private readonly region?: string;
  private readonly maxTtlSeconds: number;
  private readonly now: () => Date;
  private readonly credentials: LocalStackCloudAdapterOptions["credentials"];

  constructor(options: LocalStackCloudAdapterOptions = {}) {
    this.endpointUrl = normalizeLocalStackEndpoint(
      options.endpointUrl ?? DEFAULT_LOCALSTACK_ENDPOINT,
    );
    this.region = options.region;
    this.maxTtlSeconds = options.maxTtlSeconds ?? 3600;
    this.now = options.now ?? (() => new Date());
    this.credentials = options.credentials;
  }

  async exchange(
    intent: VerifiedCloudActionIntent,
    context: ExchangeContext,
  ): Promise<LocalStackCredential> {
    if (intent.target.provider !== "aws") {
      throw new ExchangeError(
        "provider-mismatch",
        `intent target provider is ${intent.target.provider}, not aws`,
      );
    }
    if (intent.constraints.ttlSeconds > this.maxTtlSeconds) {
      throw new ExchangeError(
        "ttl-exceeded-provider-limit",
        `LocalStackCloudAdapter maxTtlSeconds is ${this.maxTtlSeconds}, got ${intent.constraints.ttlSeconds}`,
      );
    }

    const localContext = context as LocalStackExchangeContext;
    const endpointUrl = normalizeLocalStackEndpoint(localContext.endpointUrl ?? this.endpointUrl);
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + intent.constraints.ttlSeconds * 1000);
    const tokenPart = sanitizeTokenPart(intent.requestId);

    return {
      provider: "aws",
      mode: "localstack",
      endpointUrl,
      accountRef: intent.target.providerAccountRef,
      region: intent.target.region ?? this.region ?? "ap-northeast-1",
      accessKeyId: this.credentials?.accessKeyId ?? "test",
      secretAccessKey: this.credentials?.secretAccessKey ?? "test",
      sessionToken: this.credentials?.sessionToken ?? `localstack-session-${tokenPart}`,
      requestedScopes: [...intent.action.requestedScopes],
      ...(localContext.traceLabel ? { traceLabel: localContext.traceLabel } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      forRequestId: intent.requestId,
    };
  }
}

function normalizeLocalStackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    throw new ExchangeError("context-missing", `invalid LocalStack endpoint URL: ${value}`, err);
  }
  const allowedProtocol = url.protocol === "http:" || url.protocol === "https:";
  const host = url.hostname.toLowerCase();
  const allowedHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!allowedProtocol || !allowedHost) {
    throw new ExchangeError(
      "context-missing",
      `LocalStack endpoint must be http(s) localhost/127.0.0.1/[::1], got ${url.origin}`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function sanitizeTokenPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}
