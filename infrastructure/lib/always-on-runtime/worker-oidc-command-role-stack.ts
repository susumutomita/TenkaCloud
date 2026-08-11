import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

/**
 * Issue #2555 — Worker OIDC command-seam trust.
 *
 * Registers the Always-On control-plane Worker, which serves OIDC discovery and JWKS at its
 * origin, as an IAM OIDC identity provider and creates the least-privilege
 * `tenkacloud-alwayson-command`
 * role the Worker assumes via `sts:AssumeRoleWithWebIdentity` to publish the
 * frozen `tenkacloud.deploy` EventBridge event itself.
 * This replaced the bespoke signed-intent ingress (Function URL + verifier +
 * nonce table), which the current design retired.
 *
 * Trust hardening:
 *   - `aud` is pinned with `StringEquals` to `sts.amazonaws.com`.
 *   - `sub` is pinned with `StringLike` to the command subject contract
 *     (`tenkacloud:always-on:command:<tenantId>:<eventId>`), so only tokens
 *     the Worker mints for a tenant/event-scoped command can assume the role.
 *
 * Least privilege: the role's only permission is
 * `events:PutEvents` to the one deploy bus, conditioned on the frozen
 * `events:source`. Scope is enforced by IAM, not application code.
 *
 * Like `GithubOidcDeployRoleStack`, this is a standalone, deployable Stack
 * that is intentionally NOT wired into `bin/infrastructure.ts`: the command
 * seam is an Always-On bootstrap deployed by its own entrypoint
 * (`bin/tenkacloud-always-on-command.ts`, `make deploy-always-on-command`).
 */
export interface WorkerOidcCommandRoleStackProps extends cdk.StackProps {
  /**
   * The Worker's OIDC issuer URL (its serving origin, e.g.
   * `https://tenkacloud-always-on-control-plane.example.workers.dev`).
   * Must be https, without query parameters; a trailing slash is stripped so
   * the registered issuer matches the `iss` claim the Worker derives from its
   * origin. IAM fetches `<issuer>/.well-known/openid-configuration` from it.
   */
  readonly workerIssuerUrl: string;
  /**
   * ARN of the existing deploy EventBridge bus the frozen event is published
   * onto. The role's single permission is scoped to exactly this bus.
   */
  readonly deployEventBusArn: string;
  /**
   * Existing IAM OIDC provider ARN for the Worker issuer. One AWS account can
   * hold only a single provider per issuer URL, so pass the ARN to import it
   * and avoid a create-time collision. When omitted, this stack creates one.
   */
  readonly existingOidcProviderArn?: string;
  /**
   * The OIDC `sub` claim pattern matched with `StringLike`. Defaults to
   * `tenkacloud:always-on:command:*` (any tenant/event minted by the Worker).
   * Override to pin a single tenant or event.
   */
  readonly subjectClaimPattern?: string;
  /** Physical role name. Default `tenkacloud-alwayson-command`. */
  readonly commandRoleName?: string;
}

/** OIDC audience the trust policy pins with StringEquals (web-identity standard). */
const OIDC_AUDIENCE = "sts.amazonaws.com";

/**
 * Frozen EventBridge source of the deploy contract (same literal as
 * `EVENT_SOURCE` in `lib/problem-deploy/handlers/shared/events.ts` — declared
 * here so a CDK stack does not import handler modules).
 */
export const DEPLOY_EVENT_SOURCE = "tenkacloud.deploy";

/**
 * Subject-claim contract of the command seam. The Worker mints tokens with
 * `sub = tenkacloud:always-on:command:<tenantId>:<eventId>`; the
 * default trust pattern accepts exactly this shape.
 */
export const COMMAND_SUBJECT_PREFIX = "tenkacloud:always-on:command:";

/** Default physical name of the federated command role. */
export const DEFAULT_COMMAND_ROLE_NAME = "tenkacloud-alwayson-command";

/**
 * Validate + normalize the Worker issuer URL into the two forms IAM needs:
 * the provider URL (with scheme, no trailing slash) and the condition-key
 * host (scheme stripped — IAM condition keys are `<host/path>:aud`).
 */
export function normalizeIssuer(workerIssuerUrl: string): {
  providerUrl: string;
  conditionKeyPrefix: string;
} {
  const trimmed = workerIssuerUrl.trim();
  if (!trimmed.startsWith("https://")) {
    throw new Error(
      `workerIssuerUrl must be an https:// URL (got "${workerIssuerUrl}") — IAM only trusts https OIDC issuers.`,
    );
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error(
      `workerIssuerUrl must not contain a query or fragment (got "${workerIssuerUrl}") — the OIDC spec forbids them in issuers.`,
    );
  }
  const conditionKeyPrefix = trimmed.slice("https://".length).replace(/\/+$/u, "");
  if (conditionKeyPrefix.length === 0) {
    throw new Error("workerIssuerUrl must include a hostname.");
  }
  return { providerUrl: `https://${conditionKeyPrefix}`, conditionKeyPrefix };
}

export class WorkerOidcCommandRoleStack extends cdk.Stack {
  /** ARN of the federated command role (the Worker's `COMMAND_ROLE_ARN`). */
  public readonly commandRoleArn: string;
  /** The `sub` claim pattern the trust policy enforces (exposed for assertions). */
  public readonly subjectClaimPattern: string;

  constructor(scope: Construct, id: string, props: WorkerOidcCommandRoleStackProps) {
    super(scope, id, props);

    const { providerUrl, conditionKeyPrefix } = normalizeIssuer(props.workerIssuerUrl);
    const subjectClaimPattern = props.subjectClaimPattern ?? `${COMMAND_SUBJECT_PREFIX}*`;
    this.subjectClaimPattern = subjectClaimPattern;

    // One account can only hold one provider per issuer URL: import when the
    // account already has one, otherwise create it (audience sts.amazonaws.com).
    const oidcProvider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "WorkerOidc",
          props.existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, "WorkerOidc", {
          url: providerUrl,
          clientIds: [OIDC_AUDIENCE],
        });

    const principal = new iam.OpenIdConnectPrincipal(oidcProvider, {
      StringEquals: {
        [`${conditionKeyPrefix}:aud`]: OIDC_AUDIENCE,
      },
      StringLike: {
        [`${conditionKeyPrefix}:sub`]: subjectClaimPattern,
      },
    });

    const role = new iam.Role(this, "CommandRole", {
      assumedBy: principal,
      roleName: props.commandRoleName ?? DEFAULT_COMMAND_ROLE_NAME,
      // ASCII-only (IAM Description Latin-1 gate): no arrows / em-dashes / CJK.
      description:
        "Worker OIDC federated role for TenkaCloud Always-On commands. EventBridge PutEvents only.",
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // The seam's entire permission surface: publish the frozen deploy event to
    // the one bus. Everything else (verification, replay bounds, scoping) is
    // carried by the trust policy and the short token TTL.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PutFrozenDeployEvents",
        effect: iam.Effect.ALLOW,
        actions: ["events:PutEvents"],
        resources: [props.deployEventBusArn],
        conditions: {
          StringEquals: { "events:source": DEPLOY_EVENT_SOURCE },
        },
      }),
    );

    this.commandRoleArn = role.roleArn;

    new cdk.CfnOutput(this, "CommandRoleArnOutput", {
      value: role.roleArn,
      description: "Federated command role ARN. Bind to the Worker var COMMAND_ROLE_ARN.",
    });
    new cdk.CfnOutput(this, "SubjectClaimPatternOutput", {
      value: subjectClaimPattern,
      description: "OIDC sub claim pattern enforced by the command role trust policy.",
    });
    new cdk.CfnOutput(this, "IssuerUrlOutput", {
      value: providerUrl,
      description: "Worker OIDC issuer URL registered as the IAM identity provider.",
    });
  }
}
