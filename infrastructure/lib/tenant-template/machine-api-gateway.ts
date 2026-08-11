import { RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AccessLogFormat,
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  Integration,
  IntegrationType,
  type IResource,
  LogGroupLogDestination,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import type { IUserPool, OAuthScope } from "aws-cdk-lib/aws-cognito";
import { CfnPermission, type IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  MACHINE_ROUTE_SCOPES,
  type MachineCapability,
} from "../problem-deploy/handlers/shared/machine-scopes.js";

export interface MachineApiGatewayProps {
  readonly tenantId: string;
  readonly userPool: IUserPool;
  readonly deployApiLambda: IFunction;
  readonly eventApiLambda: IFunction;
  /** {@link MachineIdentity.capabilityScopes} — method ごとの `authorizationScopes` に使う。 */
  readonly capabilityScopes: Readonly<Record<MachineCapability, OAuthScope>>;
}

/**
 * Issue #2948: machine (M2M) 専用の REST API。
 *
 * human の `TenantAPI` とは **別の RestApi** である。理由は 3 つある。
 *
 * 1. human の 46 method に `authorizationScopes` を付けた瞬間、ID token を送る SPA
 *    (`apps/application-admin-console/src/api/client.ts`) が全滅する。
 * 2. machine に見せる surface を「7 method の allowlist そのもの」として物理的に固定できる。
 *    method が増減すれば CDK test が落ち、レビューが強制される。
 * 3. CORS preflight を持たない (= browser から呼ばせない) 設定にできる。
 *
 * path は human API と byte-identical にしてある。`tcloud` CLI と OpenAPI が同じ path を指す
 * ため、将来 human API 側に寄せ直しても呼び出し側の変更が要らない。
 *
 * ## Lambda permission
 *
 * `LambdaIntegration` は method ごとに `AWS::Lambda::Permission` を作るが、Lambda の resource
 * policy は 20KB 上限があり、human API 側で既にこれを踏んでいる (`api-gateway.ts` の
 * `ApiGatewayInvokeEventRoutes` 参照)。ここでも同じ形で raw `AWS_PROXY` integration +
 * この API 全体に対する `CfnPermission` を 1 Lambda につき 1 本だけ張る。permission は
 * **API 側の stack** に置く (= Lambda 側に置くと cross-stack 依存が逆転して synth が
 * DependencyCycle になる)。
 */
export class MachineApiGateway extends Construct {
  public readonly restApi: RestApi;

  constructor(scope: Construct, id: string, props: MachineApiGatewayProps) {
    super(scope, id);

    const accessLogGroup = new LogGroup(this, "MachineApiAccessLogs", {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // machine の read 操作は admin audit log に残らない (= repo に read audit の前例が無い)。
    // 代わりに access log で追う。#2911 が要求する「完全な audit」は Phase 1 では **部分達成**
    // であり、runbook (`docs/runbooks/machine-credentials.md`) にそう明記している。
    this.restApi = new RestApi(this, `TenantMachineAPI-${props.tenantId}`, {
      endpointTypes: [EndpointType.REGIONAL],
      // defaultCorsPreflightOptions は **意図的に付けない**。machine API は browser から
      // 呼ばれる想定が無く、OPTIONS を `AuthorizationType.NONE` で開けたくない。
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(accessLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "TenantMachineCognitoAuthorizer", {
      cognitoUserPools: [props.userPool],
      authorizerName: `TenantMachineAuth-${props.tenantId}`,
    });

    for (const [constructId, lambda] of [
      ["ApiGatewayInvokeMachineDeployRoutes", props.deployApiLambda],
      ["ApiGatewayInvokeMachineEventRoutes", props.eventApiLambda],
    ] as const) {
      new CfnPermission(this, constructId, {
        action: "lambda:InvokeFunction",
        functionName: lambda.functionArn,
        principal: "apigateway.amazonaws.com",
        sourceArn: this.restApi.arnForExecuteApi(),
      });
    }

    const deployIntegration = this.proxyIntegration(props.deployApiLambda);
    const eventIntegration = this.proxyIntegration(props.eventApiLambda);

    for (const route of MACHINE_ROUTE_SCOPES) {
      const resource = this.resolveResource(route.apigwPath);
      // `/events*` は EventApi Lambda、それ以外 (`/deployments*` / `/problems*`) は DeployApi。
      const integration = route.apigwPath.startsWith("/events")
        ? eventIntegration
        : deployIntegration;
      resource.addMethod(route.method, integration, {
        authorizer,
        authorizationType: AuthorizationType.COGNITO,
        authorizationScopes: [props.capabilityScopes[route.capability].scopeName],
      });
    }
  }

  private proxyIntegration(lambda: IFunction): Integration {
    const stack = Stack.of(this);
    return new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: "POST",
      uri: `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${lambda.functionArn}/invocations`,
    });
  }

  /**
   * `/deployments/{jobId}/stack-progress` のような path を API Gateway の resource tree に
   * 変換する。既に生成済みの中間 resource は `getResource` で再利用する (= 同じ path segment を
   * 二重に `addResource` すると CDK が duplicate construct id で落ちる)。
   */
  private resolveResource(apigwPath: string): IResource {
    let resource: IResource = this.restApi.root;
    for (const segment of apigwPath.split("/").filter((value) => value.length > 0)) {
      resource = resource.getResource(segment) ?? resource.addResource(segment);
    }
    return resource;
  }
}
