import {
  type ExchangeContext,
  ExchangeError,
  type ProviderCredential,
  type ProviderTokenExchange,
} from "./provider.js";
import type { VerifiedCloudActionIntent } from "./schema.js";

/**
 * Issue #795: AwsAssumeRoleExchange adapter。
 *
 * Phase 1 で sign / verify した CloudActionIntent を、 AWS STS の AssumeRole
 * 呼び出しに変換する layer。 既存 TenkaCloud の competitor account flow
 * (= cross-account federation では ExternalId 必須) を本抽象に乗せる。
 *
 * 設計判断:
 *   - STS client は inject 可能にする (= test では fake、 production では
 *     @aws-sdk/client-sts の AssumeRoleCommand を渡す)。 本 package に
 *     `@aws-sdk/client-sts` を hard dep しない (= consumer 側で持ち込む、
 *     これにより trust-bridge は provider client universe から独立を保つ)。
 *   - ExternalId は context.externalId で渡す。cross-account federation では必ず ExternalId
 *     を要求し、渡されていなければ context-missing で fail する。
 *   - RoleArn は context.roleArn で渡す (= providerAccountRef は ID 検証用、
 *     RoleArn は具体的な ARN)。
 *   - session policy は intent.action.requestedScopes から組み立てる
 *     (= Effect=Allow + Resource="*" の minimal policy)。
 *   - DurationSeconds は intent.constraints.ttlSeconds をそのまま転写。
 *     STS の最低 limit (= 900 sec) と最大 limit (= 3600 sec) は spec の
 *     1〜3600 範囲と整合済み。
 */

export interface AwsCredential extends ProviderCredential {
  readonly provider: "aws";
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly assumedRoleArn: string;
  readonly externalId: string;
}

/**
 * STS の `AssumeRoleCommand` を呼び出す抽象。 production では
 * `@aws-sdk/client-sts` の `STSClient.send(new AssumeRoleCommand(input))` を
 * wrap する関数を渡す。 test では fake を渡す。
 */
export interface StsAssumeRoleClient {
  assumeRole(input: AssumeRoleInput): Promise<AssumeRoleOutput>;
}

export interface AssumeRoleInput {
  readonly RoleArn: string;
  readonly RoleSessionName: string;
  readonly ExternalId: string;
  readonly DurationSeconds: number;
  /** AWS session policy JSON (= 最終 effective permission)。 */
  readonly Policy?: string;
  /** 構造化 tag (= ABAC / audit 用)。 */
  readonly Tags?: readonly { readonly Key: string; readonly Value: string }[];
}

export interface AssumeRoleOutput {
  readonly Credentials: {
    readonly AccessKeyId: string;
    readonly SecretAccessKey: string;
    readonly SessionToken: string;
    readonly Expiration: Date | string;
  };
  readonly AssumedRoleUser: {
    readonly Arn: string;
  };
}

export interface AwsExchangeContext extends ExchangeContext {
  readonly roleArn: string;
  readonly externalId: string;
  readonly roleSessionName?: string;
}

export interface AwsAssumeRoleExchangeOptions {
  readonly sts: StsAssumeRoleClient;
  readonly now?: () => Date;
}

export class AwsAssumeRoleExchange implements ProviderTokenExchange<AwsCredential> {
  readonly provider = "aws" as const;
  private readonly sts: StsAssumeRoleClient;
  private readonly now: () => Date;

  constructor(options: AwsAssumeRoleExchangeOptions) {
    this.sts = options.sts;
    this.now = options.now ?? (() => new Date());
  }

  async exchange(
    intent: VerifiedCloudActionIntent,
    context: ExchangeContext,
  ): Promise<AwsCredential> {
    if (intent.target.provider !== "aws") {
      throw new ExchangeError(
        "provider-mismatch",
        `intent target provider is ${intent.target.provider}, not aws`,
      );
    }

    const awsContext = context as AwsExchangeContext;
    if (!awsContext.roleArn || awsContext.roleArn.length === 0) {
      throw new ExchangeError("context-missing", "AwsExchangeContext.roleArn is required");
    }
    if (!awsContext.externalId || awsContext.externalId.length === 0) {
      throw new ExchangeError(
        "context-missing",
        "AwsExchangeContext.externalId is required for every cross-account AssumeRole request",
      );
    }

    const duration = intent.constraints.ttlSeconds;
    if (duration < 900) {
      // STS AssumeRole の最小 DurationSeconds は 900 (= 15 min)。 spec 上限は
      // 3600 で揃えているが、 下限は STS 側で 900。 intent が短すぎる場合は
      // 900 に切り上げる代わりに ttl-exceeded-provider-limit で fail (= 静かに
      // 値を曲げず、構造化した explicit failure を返す)。
      throw new ExchangeError(
        "ttl-exceeded-provider-limit",
        `STS AssumeRole requires DurationSeconds >= 900, got ${duration}`,
      );
    }

    const policy = this.buildSessionPolicy(intent);
    const sessionName = (awsContext.roleSessionName ?? buildSessionName(intent)).slice(0, 64);
    const issuedAt = this.now();

    let output: AssumeRoleOutput;
    try {
      output = await this.sts.assumeRole({
        RoleArn: awsContext.roleArn,
        RoleSessionName: sessionName,
        ExternalId: awsContext.externalId,
        DurationSeconds: duration,
        Policy: policy,
        Tags: buildSessionTags(intent),
      });
    } catch (err) {
      throw new ExchangeError("provider-api-error", "AssumeRole failed", err);
    }

    const expiresAt =
      output.Credentials.Expiration instanceof Date
        ? output.Credentials.Expiration.toISOString()
        : new Date(output.Credentials.Expiration).toISOString();

    return {
      provider: "aws",
      accessKeyId: output.Credentials.AccessKeyId,
      secretAccessKey: output.Credentials.SecretAccessKey,
      sessionToken: output.Credentials.SessionToken,
      assumedRoleArn: output.AssumedRoleUser.Arn,
      externalId: awsContext.externalId,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
      forRequestId: intent.requestId,
    };
  }

  private buildSessionPolicy(intent: VerifiedCloudActionIntent): string | undefined {
    if (intent.action.requestedScopes.length === 0) {
      return undefined;
    }
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [...intent.action.requestedScopes],
          Resource: "*",
        },
      ],
    });
  }
}

function buildSessionName(intent: VerifiedCloudActionIntent): string {
  const parts = [
    "tenkacloud",
    intent.source.tenantId,
    intent.source.teamId,
    intent.requestId,
  ].filter((p): p is string => Boolean(p));
  return parts.join("-").replace(/[^A-Za-z0-9_=,.@-]/g, "_");
}

function buildSessionTags(
  intent: VerifiedCloudActionIntent,
): readonly { readonly Key: string; readonly Value: string }[] {
  const tags: { readonly Key: string; readonly Value: string }[] = [
    { Key: "tenkacloud:tenantId", Value: intent.source.tenantId },
    { Key: "tenkacloud:workloadId", Value: intent.source.workloadId },
    { Key: "tenkacloud:requestId", Value: intent.requestId },
    { Key: "tenkacloud:action", Value: intent.action.type },
  ];
  if (intent.source.eventId) tags.push({ Key: "tenkacloud:eventId", Value: intent.source.eventId });
  if (intent.source.teamId) tags.push({ Key: "tenkacloud:teamId", Value: intent.source.teamId });
  if (intent.source.problemId)
    tags.push({ Key: "tenkacloud:problemId", Value: intent.source.problemId });
  if (intent.source.deploymentId)
    tags.push({ Key: "tenkacloud:deploymentId", Value: intent.source.deploymentId });
  return tags;
}
