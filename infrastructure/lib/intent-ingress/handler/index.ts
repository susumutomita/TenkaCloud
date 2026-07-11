import { DdbNonceStore, verifyIntent } from "@TenkaCloud/trust-bridge";
import type { webcrypto } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { StatusCodes } from "http-status-codes";
import { createDefaultControlDataRuntime } from "../../problem-deploy/control-data/runtime-repositories.js";
import { parseProblemsCatalog } from "../../problem-deploy/handlers/shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../../problem-deploy/handlers/shared/competitor-account-lookup.js";
import { publishProblemEvent } from "../../problem-deploy/handlers/shared/events.js";
import { handleIntentIngress, type IntentIngressDeps } from "../orchestrator.js";
import { authorizeIntentScope, type IntentScopeConfig } from "../scope-authorization.js";
import { buildDdbConditionalPutClient } from "./aws-clients.js";

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * ADR-049 Phase 4 (Issue #2293): signed-intent ingress Lambda entry (Function URL).
 *
 * Receives a JWS-signed `CloudActionIntent` from the Cloudflare control plane over
 * HTTPS, verifies + authorizes it, and RE-EMITS the FROZEN EventBridge deploy event
 * onto the existing bus. It never assumes a control-plane-trusted role; the real AWS
 * SDK clients are built here and injected into the offline-testable orchestrator,
 * mirroring `customer-execution/handler/index.ts`.
 */

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

function optionalCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildScopeConfig(): IntentScopeConfig {
  const expectedAudience = process.env.EXPECTED_AUDIENCE;
  const allowedTenantIds = optionalCsv("ALLOWED_TENANT_IDS");
  const allowedEventIds = optionalCsv("ALLOWED_EVENT_IDS");
  return {
    ...(expectedAudience ? { expectedAudience } : {}),
    ...(allowedTenantIds.length > 0 ? { allowedTenantIds } : {}),
    ...(allowedEventIds.length > 0 ? { allowedEventIds } : {}),
  };
}

/** Resolve the JWS verification secret from SSM SecureString once per cold start. */
let cachedSecret: Promise<Uint8Array> | undefined;
function resolveVerifySecret(ssm: SSMClient): Promise<Uint8Array> {
  cachedSecret ??= (async () => {
    const out = await ssm.send(
      new GetParameterCommand({ Name: env("VERIFY_SECRET_PARAM"), WithDecryption: true }),
    );
    const value = out.Parameter?.Value;
    if (!value) {
      throw new Error("verify secret parameter is empty");
    }
    return new TextEncoder().encode(value);
  })();
  return cachedSecret;
}

/** Resolve the ES256 public JWK from an SSM String parameter once per cold start. */
let cachedPublicKey: Promise<JsonWebKey> | undefined;
function resolveVerifyPublicKey(ssm: SSMClient): Promise<JsonWebKey> {
  cachedPublicKey ??= (async () => {
    const out = await ssm.send(new GetParameterCommand({ Name: env("VERIFY_PUBLIC_KEY_PARAM") }));
    const value = out.Parameter?.Value;
    if (!value) {
      throw new Error("verify public key parameter is empty");
    }
    return JSON.parse(value) as JsonWebKey;
  })();
  return cachedPublicKey;
}

async function buildDeps(): Promise<IntentIngressDeps> {
  const region = process.env.AWS_REGION;
  const clientConfig = region ? { region } : {};
  const ssm = new SSMClient(clientConfig);
  const secret = await resolveVerifySecret(ssm);
  const publicJwk = await resolveVerifyPublicKey(ssm);
  const dynamodb = new DynamoDBClient(clientConfig);
  // [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance.
  const controlDataRuntime = createDefaultControlDataRuntime();
  const ddb = DynamoDBDocumentClient.from(dynamodb);

  const nonceStore = new DdbNonceStore({
    client: buildDdbConditionalPutClient(dynamodb),
    tableName: env("NONCE_TABLE_NAME"),
  });
  const events = new EventBridgeClient(clientConfig);
  const busName = env("DEPLOY_EVENT_BUS_NAME");
  const catalog = parseProblemsCatalog(process.env.PROBLEMS_CATALOG);
  const scopeConfig = buildScopeConfig();
  const competitorAccountsTableName = env("COMPETITOR_ACCOUNTS_TABLE_NAME");
  const deployEnvironment = env("DEPLOY_ENVIRONMENT");

  return {
    verify: (token) =>
      verifyIntent(token, {
        resolveSecret: () => secret,
        resolvePublicKey: () => publicJwk,
        nonceStore,
      }),
    authorizeScope: (intent) => authorizeIntentScope(intent, scopeConfig),
    resolveProblemDir: (problemId) => catalog[problemId],
    resolveVerifiedAccount: async (tenantId, awsAccountId) => {
      const verified = await resolveVerifiedCompetitorAccount(
        {
          runtime: controlDataRuntime,
          ddb,
          competitorAccountsTableName,
          env: deployEnvironment,
        },
        tenantId,
        awsAccountId,
      );
      return verified
        ? {
            competitorRoleArn: verified.competitorRoleArn,
            externalIdParameterName: verified.externalIdParameterName,
          }
        : null;
    },
    publish: (detailType, jobId, detail) =>
      publishProblemEvent({ client: events, busName, detailType, jobId, detail }),
  };
}

/** Minimal Function URL / API Gateway (payload v2) event surface used here. */
interface FunctionUrlEvent {
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

interface FunctionUrlResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function readBody(event: FunctionUrlEvent): string {
  const raw = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
}

let depsPromise: Promise<IntentIngressDeps> | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const headers = { "content-type": "application/json" };
  try {
    depsPromise ??= buildDeps();
    const deps = await depsPromise;
    const result = await handleIntentIngress(readBody(event), deps);
    return { statusCode: result.status, headers, body: JSON.stringify(result.body) };
  } catch (err) {
    // Fail loud (5xx) without leaking the raw error to the caller; the detail goes to logs.
    console.error(
      JSON.stringify({
        kind: "IntentIngressError",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      headers,
      body: JSON.stringify({ reason: "internal-error" }),
    };
  }
}
