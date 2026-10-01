import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import type { AssumedCredentials, CloudRunnerDependencies } from "./transports.js";

function explicitRegion(region: string): string {
  assertCommercialRegion(region);
  return region;
}

function requiredCredentials(credentials: AssumedCredentials): AssumedCredentials {
  if (
    !credentials?.accessKeyId ||
    !credentials.secretAccessKey ||
    !credentials.sessionToken ||
    !(credentials.expiration instanceof Date) ||
    !Number.isFinite(credentials.expiration.getTime())
  ) {
    throw new Error("CloudFormation requires complete assumed-role credentials");
  }
  return credentials;
}

/**
 * The only real AWS adapter. Constructing it makes no requests; all I/O is through the ports.
 * SSM/STS use the worker's control-plane role. CloudFormation always uses explicit short-lived
 * assumed credentials. Do not accept endpoint or credential-provider overrides from job input.
 */
export function createAwsCloudRunnerDependencies(options: {
  readonly controlPlaneRegion: string;
}): CloudRunnerDependencies {
  const sts = new STSClient({
    region: explicitRegion(options.controlPlaneRegion),
    ignoreConfiguredEndpointUrls: true,
  });
  return {
    ssm: (region) => {
      const client = new SSMClient({
        region: explicitRegion(region),
        ignoreConfiguredEndpointUrls: true,
      });
      return { getParameter: (input) => client.send(new GetParameterCommand(input)) };
    },
    sts: { assumeRole: (input) => sts.send(new AssumeRoleCommand(input)) },
    cloudFormation: ({ region, accountId, credentials }) => {
      if (!/^\d{12}$/.test(accountId)) throw new Error("An explicit AWS account is required");
      const client = new CloudFormationClient({
        region: explicitRegion(region),
        credentials: { ...requiredCredentials(credentials), accountId },
        ignoreConfiguredEndpointUrls: true,
      });
      return {
        describeStacks: (input) => client.send(new DescribeStacksCommand(input)),
        deleteStack: (input) => client.send(new DeleteStackCommand(input)),
        createStack: (input) =>
          client.send(
            new CreateStackCommand({
              ...input,
              Parameters: input.Parameters.map((value) => ({ ...value })),
              Capabilities: [...input.Capabilities],
              Tags: input.Tags.map((value) => ({ ...value })),
            }),
          ),
      };
    },
  };
}
