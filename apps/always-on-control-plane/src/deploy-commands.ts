import {
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_PROBLEM_ID_PATTERN,
  deploySlugify,
  deployStackPrefix,
} from "@TenkaCloud/trust-bridge";
import { z } from "zod";
import { assumeCommandRole, mintCommandToken, putDeployEvent } from "./aws-command.js";
import type { OidcEnvironment } from "./oidc.js";

/**
 * Issue #2555: organizer deploy/destroy commands over the
 * OIDC command seam.
 *
 * Turns an organizer's command into the FROZEN `tenkacloud.deploy` EventBridge
 * event and publishes it with web-identity credentials (aws-command.ts). The
 * command carries only identifiers; `competitorRoleArn` and the ExternalId SSM
 * parameter name are resolved fail-closed from the control store's
 * tenant-owned account projection — mirroring the verified-account check the
 * retired ingress performed against DynamoDB (#2362). `problemDir` is resolved
 * from the `PROBLEMS_CATALOG` binding (problemId → problemDir), the Worker-side
 * equivalent of the catalog the ingress had baked in at build time.
 */

/**
 * Organizer command body. Identifier shapes mirror the frozen deploy detail
 * schema (via the trust-bridge patterns), so a command downstream would reject
 * fails fast at the edge. `deploymentId` is the identity a deploy 202
 * returned; a destroy MUST reference it so the downstream jobId matches the
 * deployment row being destroyed (a deploy must not supply one — the Worker
 * mints it).
 */
export const DeployCommandInputSchema = z
  .object({
    action: z.enum(["deploy", "destroy"]),
    teamId: z.string().min(1),
    problemId: z.string().regex(DEPLOY_PROBLEM_ID_PATTERN, "must be a lowercase problem slug"),
    awsAccountId: z
      .string()
      .regex(DEPLOY_AWS_ACCOUNT_ID_PATTERN, "must be a 12-digit AWS account id"),
    region: z.string().regex(DEPLOY_AWS_REGION_PATTERN, "must be an AWS region name"),
    deploymentId: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "deploy" && input.deploymentId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deploymentId"],
        message: "must be omitted for deploy commands (the Worker mints it)",
      });
    }
    if (input.action === "destroy" && input.deploymentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deploymentId"],
        message: "destroy requires the deploymentId returned by the original deploy",
      });
    }
  });

export type DeployCommandInput = z.infer<typeof DeployCommandInputSchema>;

/**
 * System-admin registration body for a tenant-owned deployment account (the
 * fail-closed source `executeDeployCommand` resolves against). The two values
 * ride verbatim in the frozen event, mirroring the CompetitorAccounts row the
 * AWS-side check consumed (#2362).
 */
export const CompetitorAccountRegistrationSchema = z
  .object({
    competitorRoleArn: z
      .string()
      .regex(/^arn:aws[a-z0-9-]*:iam::\d{12}:role\/.+$/u, "must be an IAM role ARN"),
    externalIdParameterName: z
      .string()
      .regex(/^\/.+/u, "must be an SSM parameter path (leading slash)"),
  })
  .strict();

export type DeployCommand = DeployCommandInput & {
  readonly tenantId: string;
  readonly eventId: string;
  /** The Worker origin — must equal the OIDC issuer registered with IAM. */
  readonly issuer: string;
};

/** Bindings consumed here; the OIDC secret is validated at mint time. */
export interface CommandEnvironment extends OidcEnvironment {
  readonly COMMAND_ROLE_ARN?: string;
  readonly COMMAND_AWS_REGION?: string;
  readonly COMMAND_EVENT_BUS_ARN?: string;
  /** JSON map problemId → problemDir (the Always-On problems catalog). */
  readonly PROBLEMS_CATALOG?: string;
}

export interface CommandGateway {
  readonly roleArn: string;
  readonly region: string;
  readonly eventBusArn: string;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly environment: OidcEnvironment;
  readonly fetchImpl: typeof fetch;
}

export type DeployCommandOutcome =
  | { readonly accepted: true; readonly requestId: string; readonly deploymentId: string }
  /** The organizer's command itself was rejected (correctable input/state). */
  | { readonly accepted: false; readonly kind: "rejected"; readonly reason: string }
  /** The AWS exchange or publish failed (platform-side, not correctable by the organizer). */
  | { readonly accepted: false; readonly kind: "gateway"; readonly reason: string };

export interface ResolvedCompetitorAccount {
  readonly competitorRoleArn: string;
  readonly externalIdParameterName: string;
}

/** Fail-closed account resolution seam (bound to the control store by the route). */
export type ResolveCompetitorAccount = (
  tenantId: string,
  awsAccountId: string,
) => Promise<ResolvedCompetitorAccount | null>;

function requiredBinding(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function commandGatewayFromEnvironment(
  environment: CommandEnvironment,
  fetchImpl: typeof fetch,
): CommandGateway {
  const catalogJson = requiredBinding(environment.PROBLEMS_CATALOG, "PROBLEMS_CATALOG");
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogJson);
  } catch {
    throw new Error("PROBLEMS_CATALOG must be valid JSON");
  }
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    throw new Error("PROBLEMS_CATALOG must be a JSON object (problemId -> problemDir)");
  }
  for (const value of Object.values(catalog)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("PROBLEMS_CATALOG values must be non-empty problemDir strings");
    }
  }
  return {
    roleArn: requiredBinding(environment.COMMAND_ROLE_ARN, "COMMAND_ROLE_ARN"),
    region: requiredBinding(environment.COMMAND_AWS_REGION, "COMMAND_AWS_REGION"),
    eventBusArn: requiredBinding(environment.COMMAND_EVENT_BUS_ARN, "COMMAND_EVENT_BUS_ARN"),
    problemsCatalog: catalog as Record<string, string>,
    environment,
    fetchImpl,
  };
}

/**
 * Execute one deploy/destroy command over the OIDC seam. For a deploy,
 * `deploymentId` is pinned to the minted `requestId`, so the downstream jobId
 * equals the requestId returned to the organizer. For a destroy, the
 * caller-supplied `deploymentId` (from the original deploy 202) is carried
 * instead, so the downstream delete marks the SAME deployment row.
 */
export async function executeDeployCommand(
  command: DeployCommand,
  gateway: CommandGateway,
  resolveAccount: ResolveCompetitorAccount,
): Promise<DeployCommandOutcome> {
  const requestId = crypto.randomUUID();
  const deploymentId = command.deploymentId ?? requestId;

  const problemDir = gateway.problemsCatalog[command.problemId];
  if (problemDir === undefined) {
    return { accepted: false, kind: "rejected", reason: "unknown-problem-dir" };
  }
  const teamSlug = deploySlugify(command.teamId);
  if (teamSlug.length === 0) {
    return { accepted: false, kind: "rejected", reason: "team-slug-invalid" };
  }
  // Fail closed: only a registered tenant-owned account may be deployed into,
  // and the pair rides in the event so downstream execution cannot fall back
  // to same-account credentials (#2362 posture, control-store edition).
  const account = await resolveAccount(command.tenantId, command.awsAccountId);
  if (account === null) {
    return { accepted: false, kind: "rejected", reason: "account-not-verified" };
  }

  const shared = {
    jobId: deploymentId,
    correlationId: requestId,
    tenantId: command.tenantId,
    region: command.region,
    awsAccountId: command.awsAccountId,
    competitorRoleArn: account.competitorRoleArn,
    externalIdParameterName: account.externalIdParameterName,
  };
  const detail: Record<string, unknown> =
    command.action === "deploy"
      ? {
          ...shared,
          problemId: command.problemId,
          problemDir,
          teamSlug,
          namePrefix: deployStackPrefix(command.problemId, command.teamId),
        }
      : {
          ...shared,
          stackName: deployStackPrefix(command.problemId, command.teamId),
        };

  const token = await mintCommandToken({
    environment: gateway.environment,
    issuer: command.issuer,
    tenantId: command.tenantId,
    eventId: command.eventId,
  });
  const exchange = await assumeCommandRole({
    token,
    roleArn: gateway.roleArn,
    region: gateway.region,
    sessionName: `always-on-command-${requestId}`,
    fetchImpl: gateway.fetchImpl,
  });
  if (!exchange.ok) {
    console.error(
      JSON.stringify({
        event: "always-on.deploy-command.sts-exchange-failed",
        status: exchange.status,
      }),
    );
    return { accepted: false, kind: "gateway", reason: "sts-exchange-failed" };
  }

  const published = await putDeployEvent({
    credentials: exchange.credentials,
    region: gateway.region,
    eventBusArn: gateway.eventBusArn,
    detailType: command.action === "deploy" ? "DeployCreateRequested" : "DeployDeleteRequested",
    jobId: deploymentId,
    detail,
    fetchImpl: gateway.fetchImpl,
  });
  if (!published.ok) {
    console.error(
      JSON.stringify({
        event: "always-on.deploy-command.event-publish-failed",
        status: published.status,
      }),
    );
    return { accepted: false, kind: "gateway", reason: "event-publish-failed" };
  }

  return { accepted: true, requestId, deploymentId };
}
