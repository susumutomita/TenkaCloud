import { isDeepStrictEqual } from "node:util";
import { type CloudControlDataConfiguration, cloudControlDataConfiguration } from "./config.js";

type ObjectRecord = Record<string, unknown>;
const POOL_ID = "IdentityProvidertenantUserPoolC77ED8F6";
const SAML_TABLE_ID = "SamlIdpsTable774D9129";
const BACKEND_TABLES: Readonly<Record<string, readonly string[]>> = {
  DeploymentsTableDD4203FA: ["GSI1", "GSI2", "GSI3"],
  EventsTable4B7491D3: ["GSI1"],
  TeamsTable29FBC014: ["GSI1"],
  ProblemEndpointsTableEB12A2E1: [],
  CompetitorAccountsTable2661C473: [],
  DisruptionsTable17A39504: ["GSI1"],
  AdminAuditLogTable670D7986: ["GSI1"],
};
const BACKEND_FUNCTIONS = [
  "DeployApiFunctionC6EAEF11",
  "EventApiFunction801117B3",
  "CompetitorAccountsApiFunction24E5F35B",
  "ParticipantPortalLambdaFunctionC0659CBE",
] as const;

function fail(detail: string): never {
  throw new Error(
    `Existing stack is not the characterized historical Lite layout: ${detail}. Refusing resource adoption.`,
  );
}
function record(value: unknown, label: string): ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(label);
  return value as ObjectRecord;
}
function resource(resources: ObjectRecord, id: string, type: string): ObjectRecord {
  const found = record(resources[id], `missing ${id}`);
  if (found.Type !== type) return fail(`${id} type`);
  return record(found.Properties, `${id} properties`);
}
function keySchema(partition: string, sort: string) {
  return [
    { AttributeName: partition, KeyType: "HASH" },
    { AttributeName: sort, KeyType: "RANGE" },
  ];
}
function assertTable(
  resources: ObjectRecord,
  id: string,
  indexes: readonly string[],
  lowerCase = false,
): void {
  const table = resource(resources, id, "AWS::DynamoDB::Table");
  const pk = lowerCase ? "pk" : "PK";
  const sk = lowerCase ? "sk" : "SK";
  if (!isDeepStrictEqual(table.KeySchema, keySchema(pk, sk))) fail(`${id} primary key schema`);
  const expectedAttributes = [pk, sk, ...indexes.flatMap((name) => [`${name}PK`, `${name}SK`])].map(
    (AttributeName) => ({ AttributeName, AttributeType: "S" }),
  );
  if (!isDeepStrictEqual(table.AttributeDefinitions, expectedAttributes))
    fail(`${id} key attribute definitions`);
  const actualIndexes = table.GlobalSecondaryIndexes ?? [];
  if (!Array.isArray(actualIndexes) || actualIndexes.length !== indexes.length)
    fail(`${id} indexes`);
  for (const [index, name] of indexes.entries()) {
    const actual = record(actualIndexes[index], `${id}/${name}`);
    if (
      actual.IndexName !== name ||
      !isDeepStrictEqual(actual.KeySchema, keySchema(`${name}PK`, `${name}SK`)) ||
      !isDeepStrictEqual(actual.Projection, { ProjectionType: "ALL" })
    )
      fail(`${id}/${name} schema`);
  }
  if (table.LocalSecondaryIndexes !== undefined) fail(`${id} unexpected local indexes`);
}
function functionVariables(resources: ObjectRecord, id: string): ObjectRecord {
  const fn = resource(resources, id, "AWS::Lambda::Function");
  return record(record(fn.Environment, `${id} environment`).Variables, `${id} variables`);
}
function providerFromVariables(variables: ObjectRecord): CloudControlDataConfiguration {
  const backend = variables.CONTROL_DATA_BACKEND;
  if (backend === undefined || backend === "dynamodb") return { kind: "dynamodb" };
  if (
    backend !== "turso" ||
    typeof variables.TURSO_DATABASE_URL !== "string" ||
    typeof variables.TURSO_AUTH_TOKEN_PARAMETER_NAME !== "string"
  )
    fail("repository provider configuration");
  return cloudControlDataConfiguration({
    CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    CDK_PARAM_TURSO_DATABASE_URL: variables.TURSO_DATABASE_URL,
    CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: variables.TURSO_AUTH_TOKEN_PARAMETER_NAME,
  });
}
function assertAppIdentity(resources: ObjectRecord): void {
  const pool = resource(resources, POOL_ID, "AWS::Cognito::UserPool");
  const expectedSchema = [
    { Mutable: true, Name: "email", Required: true },
    ...["tenantId", "userRole", "apiKey", "tenantTier", "tenantName"].map((Name) => ({
      AttributeDataType: "String",
      Mutable: true,
      Name,
    })),
  ];
  if (!isDeepStrictEqual(pool.Schema, expectedSchema)) fail("Cognito schema");
  for (const [id, type] of [
    ["IdentityProvidertenantUserPoolClient01DA8A68", "AWS::Cognito::UserPoolClient"],
    ["IdentityProvidertenantUserPooltenantUserPoolDomainCDB109D1", "AWS::Cognito::UserPoolDomain"],
  ] as const) {
    if (!isDeepStrictEqual(resource(resources, id, type).UserPoolId, { Ref: POOL_ID }))
      fail(`${id} pool linkage`);
  }
  resource(resources, "ApiGatewayTenantAPIlocal720C8393", "AWS::ApiGateway::RestApi");
  resource(resources, "ApplicationAdminConsoleHostingSiteBucketB91BAC99", "AWS::S3::Bucket");
}
function assertBackendIdentity(resources: ObjectRecord): void {
  resource(resources, "LocalEventBusC7491FAF", "AWS::Events::EventBus");
  resource(resources, "DeployCreateStateMachine9B2B6CCA", "AWS::StepFunctions::StateMachine");
  resource(resources, "DeployDeleteStateMachine1D16E7A9", "AWS::StepFunctions::StateMachine");
  resource(resources, "ParticipantPortalSiteBucketF685E182", "AWS::S3::Bucket");
  resource(resources, "CompetitorBootstrapHostingBucket9F1B78E9", "AWS::S3::Bucket");
}

function assertProviderTables(
  resources: ObjectRecord,
  kind: "app" | "backend",
  provider: CloudControlDataConfiguration,
): void {
  const tables = Object.values(resources).filter(
    (value) => record(value, "resource").Type === "AWS::DynamoDB::Table",
  );
  if (provider.kind === "turso") {
    if (tables.length !== 0) fail("Turso layout contains DynamoDB tables");
  } else if (kind === "app") {
    if (tables.length !== 1) fail("application table set");
    assertTable(resources, SAML_TABLE_ID, [], true);
    if (
      !isDeepStrictEqual(
        functionVariables(resources, "SamlIdpFunction2BF6E8DD").SAML_IDPS_TABLE_NAME,
        { Ref: SAML_TABLE_ID },
      )
    )
      fail("SAML repository table linkage");
  } else {
    if (tables.length !== Object.keys(BACKEND_TABLES).length) fail("backend table set");
    for (const [id, indexes] of Object.entries(BACKEND_TABLES)) assertTable(resources, id, indexes);
  }
}

/**
 * Template identity proof only. Caller must separately verify exact physical stack name,
 * account/region and historical Project/Environment tags before allowing any update.
 * This does not migrate the published cloud-v1 database or assume compatible records.
 */
export function assertHistoricalLiteTemplate(
  template: unknown,
  kind: "app" | "backend",
): CloudControlDataConfiguration {
  const resources = record(record(template, "template").Resources, "resources");
  const resourceTypes = Object.values(resources).map((value) => record(value, "resource").Type);
  if (
    resourceTypes.includes("AWS::CodePipeline::Pipeline") ||
    resourceTypes.filter((type) => type === "AWS::Cognito::UserPool").length !==
      (kind === "app" ? 1 : 0)
  )
    fail("unexpected provisioning or identity resources");
  if (kind === "app") assertAppIdentity(resources);
  else assertBackendIdentity(resources);
  const functionIds = kind === "app" ? ["SamlIdpFunction2BF6E8DD"] : BACKEND_FUNCTIONS;
  const providers = functionIds.map((id) =>
    providerFromVariables(functionVariables(resources, id)),
  );
  const provider = providers[0];
  if (!provider || providers.some((value) => !isDeepStrictEqual(value, provider)))
    fail("inconsistent repository providers");
  assertProviderTables(resources, kind, provider);
  return provider;
}
