import { App, type CfnElement, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Code, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiGateway } from "../../lib/tenant-template/api-gateway.js";
import { LAMBDA_NODEJS_RUNTIME } from "../../lib/utils/lambda-runtime.js";

/**
 * The tenant REST API lists its routes one by one; there is no `{proxy+}`. A handler route
 * with no gateway method is rejected before the Lambda runs (#3252 bulk register, #3284 team
 * key rotation), and a gateway method whose handler route was deleted forwards to a 404 (#3285
 * rotate-external-id). This compares both sides for every Lambda behind the gateway.
 */

const BACKENDS = ["DeployApi", "EventApi", "CompetitorAccountsApi", "SamlIdp"] as const;
type Backend = (typeof BACKENDS)[number];

const HANDLER_APPS: Record<Backend, () => Promise<{ app: Hono }>> = {
  DeployApi: () => import("../../lib/problem-deploy/handlers/deploy-handler/index.js"),
  EventApi: () => import("../../lib/problem-deploy/handlers/event-handler/index.js"),
  CompetitorAccountsApi: () =>
    import("../../lib/problem-deploy/handlers/competitor-accounts-handler/index.js"),
  SamlIdp: () => import("../../lib/tenant-template/handlers/idp-handler/index.js"),
};

// The entry modules compose their shared resources at import time and throw on these.
const ENTRY_MODULE_ENV = {
  DEPLOY_ENVIRONMENT: "development",
  DEPLOY_EVENT_BUS_NAME: "test-bus",
  TENKACLOUD_ACCOUNT_ID: "111111111111",
  TENANT_USER_POOL_ID: "test-pool",
  SAML_IDPS_TABLE_NAME: "TestSamlIdps",
};

interface HandlerOnlyRoute {
  readonly backend: Backend;
  /** `METHOD /path/{param}`, the gateway's spelling. */
  readonly route: string;
  readonly reason: string;
  readonly issue: number;
  /** Handler-only only in this state of the deploy-time `nonAwsRuntime` feature. */
  readonly whenNonAwsRuntime?: boolean;
}

const NON_AWS_RUNTIME_OFF_REASON =
  "nonAwsRuntime off: the console hides it and the gateway does not expose it (#3290)";

const TEAM_CLOUD_CREDENTIAL_ROUTES = [
  "GET /admin/team-cloud-credentials/{provider}/{teamSlug}",
  "PUT /admin/team-cloud-credentials/{provider}/{teamSlug}",
  "DELETE /admin/team-cloud-credentials/{provider}/{teamSlug}",
];

/** Handler routes that deliberately have no gateway method. */
const HANDLER_ONLY_ROUTES: readonly HandlerOnlyRoute[] = [
  {
    backend: "DeployApi",
    route: "GET /healthz",
    reason: "Lambda liveness probe. Nothing calls it through the tenant gateway.",
    issue: 3285,
  },
  {
    backend: "EventApi",
    route: "GET /events/healthz",
    reason: "Lambda liveness probe. Nothing calls it through the tenant gateway.",
    issue: 3285,
  },
  {
    backend: "CompetitorAccountsApi",
    route: "GET /admin/competitor-accounts/healthz",
    reason: "Lambda liveness probe. Nothing calls it through the tenant gateway.",
    issue: 3285,
  },
  {
    backend: "SamlIdp",
    route: "GET /tenant/idp/healthz",
    reason: "Lambda liveness probe. Nothing calls it through the tenant gateway.",
    issue: 3285,
  },
  ...TEAM_CLOUD_CREDENTIAL_ROUTES.map(
    (route): HandlerOnlyRoute => ({
      backend: "CompetitorAccountsApi",
      route,
      reason: NON_AWS_RUNTIME_OFF_REASON,
      issue: 3290,
      whenNonAwsRuntime: false,
    }),
  ),
];

type CfnProps = Record<string, unknown>;
type CfnRef = { Ref?: string } | undefined;

interface GatewaySide {
  readonly routes: Record<Backend, string[]>;
  readonly unmapped: string[];
}

function synthGateway(nonAwsRuntime: boolean): GatewaySide {
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, "TestStack");
  const userPool = new UserPool(stack, "UP");
  const functions = Object.fromEntries(
    BACKENDS.map((backend) => [
      backend,
      new LambdaFunction(stack, backend, {
        runtime: LAMBDA_NODEJS_RUNTIME,
        code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 })"),
        handler: "index.handler",
      }),
    ]),
  ) as Record<Backend, LambdaFunction>;
  const tenantApi = new ApiGateway(stack, "ApiGateway", {
    tenantId: "tenant-acme",
    userPool,
    deployApiLambda: functions.DeployApi,
    eventApiLambda: functions.EventApi,
    competitorAccountsApiLambda: functions.CompetitorAccountsApi,
    samlIdpLambda: functions.SamlIdp,
    teamCloudCredentialsRoutes: nonAwsRuntime,
  });
  const template = Template.fromStack(Stack.of(tenantApi));

  const backendLogicalIds = BACKENDS.map(
    (backend) =>
      [backend, stack.getLogicalId(functions[backend].node.defaultChild as CfnElement)] as const,
  );
  const resources = template.findResources("AWS::ApiGateway::Resource");
  // The root resource is referenced with Fn::GetAtt RootResourceId rather than Ref.
  const pathOf = (ref: CfnRef): string => {
    const resource = ref?.Ref ? resources[ref.Ref] : undefined;
    if (!resource) return "";
    const props = resource.Properties as CfnProps;
    return `${pathOf(props.ParentId as CfnRef)}/${String(props.PathPart)}`;
  };

  const routes = Object.fromEntries(BACKENDS.map((backend) => [backend, [] as string[]])) as Record<
    Backend,
    string[]
  >;
  const unmapped: string[] = [];
  for (const method of Object.values(template.findResources("AWS::ApiGateway::Method"))) {
    const props = method.Properties as CfnProps;
    if (props.HttpMethod === "OPTIONS") continue;
    const route = `${String(props.HttpMethod)} ${pathOf(props.ResourceId as CfnRef) || "/"}`;
    const uri = JSON.stringify((props.Integration as CfnProps | undefined)?.Uri ?? null);
    const targets = backendLogicalIds.filter(([, logicalId]) => uri.includes(`"${logicalId}"`));
    const target = targets.length === 1 ? targets[0]?.[0] : undefined;
    if (target) routes[target].push(route);
    else unmapped.push(route);
  }
  return { routes, unmapped };
}

async function handlerRoutes(backend: Backend): Promise<Set<string>> {
  const { app } = await HANDLER_APPS[backend]();
  return new Set(
    app.routes
      // `app.use` middleware is registered under the pseudo-method ALL.
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, "{$1}")}`),
  );
}

describe("tenant API Gateway and handler route parity (#3285)", () => {
  let handlers: Record<Backend, Set<string>>;

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ENTRY_MODULE_ENV)) vi.stubEnv(name, value);
    handlers = Object.fromEntries(
      await Promise.all(
        BACKENDS.map(async (backend) => [backend, await handlerRoutes(backend)] as const),
      ),
    ) as Record<Backend, Set<string>>;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe.each([{ nonAwsRuntime: false }, { nonAwsRuntime: true }])(
    "with nonAwsRuntime=$nonAwsRuntime",
    ({ nonAwsRuntime }) => {
      const gateway = synthGateway(nonAwsRuntime);

      it("should integrate every gateway method with exactly one backing Lambda", () => {
        expect(gateway.unmapped).toEqual([]);
      });

      it.each(BACKENDS)("should back every %s gateway method with a handler route", (backend) => {
        const orphans = gateway.routes[backend].filter((route) => !handlers[backend].has(route));
        expect(orphans).toEqual([]);
      });

      it.each(BACKENDS)(
        "should expose every %s handler route on the gateway unless it is listed as handler-only",
        (backend) => {
          const onGateway = new Set(gateway.routes[backend]);
          const handlerOnly = [...handlers[backend]]
            .filter((route) => !onGateway.has(route))
            .sort();
          const listed = HANDLER_ONLY_ROUTES.filter(
            (entry) =>
              entry.backend === backend &&
              (entry.whenNonAwsRuntime ?? nonAwsRuntime) === nonAwsRuntime,
          )
            .map((entry) => entry.route)
            .sort();
          expect(handlerOnly).toEqual(listed);
        },
      );

      it("should expose the team cloud credential routes exactly when nonAwsRuntime is on (#3290)", () => {
        const exposed = TEAM_CLOUD_CREDENTIAL_ROUTES.filter((route) =>
          gateway.routes.CompetitorAccountsApi.includes(route),
        );
        expect(exposed).toEqual(nonAwsRuntime ? TEAM_CLOUD_CREDENTIAL_ROUTES : []);
      });
    },
  );
});
