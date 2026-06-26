import { ParameterTier, ParameterType, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const REGION = "us-east-1";
const ACCOUNT_ID = "000000000000";

type TemplateRecord = Record<string, unknown>;

interface MaterializedResource {
  readonly ref: string;
  readonly attributes: Readonly<Record<string, string>>;
}

interface ResolveContext {
  readonly parameters: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, MaterializedResource>>;
}

function record(value: unknown, field: string): TemplateRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as TemplateRecord;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must resolve to a string`);
  return value;
}

function resolveSub(template: string, context: ResolveContext): string {
  return template.replace(/\${([^}]+)}/g, (_match, variable: string) => {
    if (variable === "AWS::Region") return REGION;
    if (variable === "AWS::AccountId") return ACCOUNT_ID;
    const [logicalId, attribute] = variable.split(".", 2);
    if (attribute) {
      const resolved = context.resources[logicalId]?.attributes[attribute];
      if (resolved !== undefined) return resolved;
    }
    const parameter = context.parameters[variable];
    if (parameter !== undefined) return parameter;
    const resource = context.resources[variable]?.ref;
    if (resource !== undefined) return resource;
    throw new Error(`Fn::Sub variable "${variable}" is not available in local play`);
  });
}

function resolveRef(reference: string, context: ResolveContext): string {
  const parameter = context.parameters[reference];
  if (parameter !== undefined) return parameter;
  const resource = context.resources[reference]?.ref;
  if (resource !== undefined) return resource;
  throw new Error(`Ref "${reference}" is not available in local play`);
}

function resolveGetAtt(value: readonly unknown[], context: ResolveContext): string {
  const [logicalId, attribute] = value;
  if (typeof logicalId !== "string" || typeof attribute !== "string") {
    throw new Error("Fn::GetAtt must contain a logical id and attribute");
  }
  const resolved = context.resources[logicalId]?.attributes[attribute];
  if (resolved === undefined) {
    throw new Error(`Fn::GetAtt "${logicalId}.${attribute}" is not available in local play`);
  }
  return resolved;
}

function resolveValue(value: unknown, context: ResolveContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, context));
  if (typeof value !== "object" || value === null) return value;
  const object = value as TemplateRecord;
  const singleKey = Object.keys(object).length === 1;
  if (singleKey && typeof object.Ref === "string") return resolveRef(object.Ref, context);
  if (singleKey && typeof object["Fn::Sub"] === "string") {
    return resolveSub(object["Fn::Sub"], context);
  }
  if (singleKey && Array.isArray(object["Fn::GetAtt"])) {
    return resolveGetAtt(object["Fn::GetAtt"], context);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, resolveValue(entry, context)]),
  );
}

function initialResource(
  logicalId: string,
  definition: TemplateRecord,
  stackName: string,
  parameters: Readonly<Record<string, string>>,
): MaterializedResource {
  const type = stringValue(definition.Type, `Resources.${logicalId}.Type`);
  const properties = record(definition.Properties ?? {}, `Resources.${logicalId}.Properties`);
  const context: ResolveContext = { parameters, resources: {} };
  if (type === "AWS::SSM::Parameter") {
    const name = stringValue(
      resolveValue(properties.Name, context),
      `Resources.${logicalId}.Properties.Name`,
    );
    return {
      ref: name,
      attributes: {
        Arn: `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${name}`,
      },
    };
  }
  if (type === "AWS::IAM::Role") {
    const roleName =
      properties.RoleName !== undefined
        ? stringValue(
            resolveValue(properties.RoleName, context),
            `Resources.${logicalId}.Properties.RoleName`,
          )
        : `${stackName}-${logicalId}`.slice(0, 64);
    return {
      ref: roleName,
      attributes: {
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
      },
    };
  }
  throw new Error(`local play does not support CloudFormation resource type ${type}`);
}

async function callIam(
  endpoint: string,
  action: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const body = new URLSearchParams({ Action: action, Version: "2010-05-08", ...values });
  const response = await fetch(`${endpoint}/iam`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Kumo IAM ${action} failed: ${await response.text()}`);
  }
}

async function createIamRole(
  endpoint: string,
  logicalId: string,
  definition: TemplateRecord,
  resource: MaterializedResource,
  context: ResolveContext,
): Promise<void> {
  const properties = record(definition.Properties ?? {}, `Resources.${logicalId}.Properties`);
  const trust = resolveValue(properties.AssumeRolePolicyDocument, context);
  await callIam(endpoint, "CreateRole", {
    RoleName: resource.ref,
    AssumeRolePolicyDocument: JSON.stringify(trust),
    ...(typeof properties.MaxSessionDuration === "number"
      ? { MaxSessionDuration: String(properties.MaxSessionDuration) }
      : {}),
  });
  const managedPolicies = resolveValue(properties.ManagedPolicyArns ?? [], context);
  if (!Array.isArray(managedPolicies)) {
    throw new Error(`Resources.${logicalId}.Properties.ManagedPolicyArns must be an array`);
  }
  for (const policyArn of managedPolicies) {
    const arn = stringValue(policyArn, `Resources.${logicalId}.ManagedPolicyArns`);
    if (arn.startsWith("arn:aws:iam::aws:policy/")) {
      console.warn(`Kumo does not preload AWS managed policy ${arn}; skipping local attachment.`);
      continue;
    }
    await callIam(endpoint, "AttachRolePolicy", {
      RoleName: resource.ref,
      PolicyArn: arn,
    });
  }
  const policies = resolveValue(properties.Policies ?? [], context);
  if (!Array.isArray(policies)) {
    throw new Error(`Resources.${logicalId}.Properties.Policies must be an array`);
  }
  for (const rawPolicy of policies) {
    const policy = record(rawPolicy, `Resources.${logicalId}.Properties.Policies[]`);
    await callIam(endpoint, "PutRolePolicy", {
      RoleName: resource.ref,
      PolicyName: stringValue(policy.PolicyName, "PolicyName"),
      PolicyDocument: JSON.stringify(policy.PolicyDocument),
    });
  }
}

function makeSsmClient(endpoint: string): SSMClient {
  return new SSMClient({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });
}

async function createSsmParameter(
  client: SSMClient,
  logicalId: string,
  definition: TemplateRecord,
  resource: MaterializedResource,
  context: ResolveContext,
): Promise<MaterializedResource> {
  const properties = record(definition.Properties ?? {}, `Resources.${logicalId}.Properties`);
  const value = stringValue(
    resolveValue(properties.Value, context),
    `Resources.${logicalId}.Properties.Value`,
  );
  const type = resolveValue(properties.Type ?? "String", context);
  const tier = resolveValue(properties.Tier ?? "Standard", context);
  const description = resolveValue(properties.Description, context);
  await client.send(
    new PutParameterCommand({
      Name: resource.ref,
      Value: value,
      Type:
        type === "StringList"
          ? ParameterType.STRING_LIST
          : type === "SecureString"
            ? ParameterType.SECURE_STRING
            : ParameterType.STRING,
      Tier:
        tier === "Advanced"
          ? ParameterTier.ADVANCED
          : tier === "Intelligent-Tiering"
            ? ParameterTier.INTELLIGENT_TIERING
            : ParameterTier.STANDARD,
      ...(typeof description === "string" ? { Description: description } : {}),
      Overwrite: true,
    }),
  );
  return {
    ...resource,
    attributes: {
      ...resource.attributes,
      Value: value,
      Type: String(type),
    },
  };
}

export async function materializeTemplate(
  endpoint: string,
  stackName: string,
  templateBody: string,
  templateParameters: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  const template = record(JSON.parse(templateBody), "template");
  const definitions = record(template.Resources ?? {}, "Resources");
  const resources: Record<string, MaterializedResource> = {};
  for (const [logicalId, rawDefinition] of Object.entries(definitions)) {
    resources[logicalId] = initialResource(
      logicalId,
      record(rawDefinition, `Resources.${logicalId}`),
      stackName,
      templateParameters,
    );
  }

  const context: ResolveContext = { parameters: templateParameters, resources };
  const ssm = makeSsmClient(endpoint);
  for (const [logicalId, rawDefinition] of Object.entries(definitions)) {
    const definition = record(rawDefinition, `Resources.${logicalId}`);
    const type = stringValue(definition.Type, `Resources.${logicalId}.Type`);
    if (type === "AWS::IAM::Role") {
      await createIamRole(endpoint, logicalId, definition, resources[logicalId], context);
    } else if (type === "AWS::SSM::Parameter") {
      resources[logicalId] = await createSsmParameter(
        ssm,
        logicalId,
        definition,
        resources[logicalId],
        context,
      );
    }
  }

  const outputs: Record<string, string> = {};
  const outputDefinitions = record(template.Outputs ?? {}, "Outputs");
  for (const [key, rawOutput] of Object.entries(outputDefinitions)) {
    const output = record(rawOutput, `Outputs.${key}`);
    const resolved = resolveValue(output.Value, context);
    outputs[key] = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  }
  return outputs;
}
