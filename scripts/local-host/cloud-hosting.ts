import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { assumeRoleWithExternalId } from "../../infrastructure/lib/problem-deploy/handlers/shared/assume-competitor-role";
import { CloudFormationEngine, type CloudFormationEngineOptions } from "./cloudformation-engine";
import { persistentKey, privateDirectory } from "./files";
import type { Job, Team } from "./model";

/** What `--aws-region` adds to a host: the identity competitor accounts trust, and the engine. */
export interface CloudHosting {
  readonly region: string;
  readonly operatorAccountId: string;
  readonly externalId: string;
  readonly externalIdPath: string;
  verify(accountId: string, roleName: string): Promise<void>;
  engine(team: (job: Job) => Team): CloudFormationEngine;
}

type AwsClients = Pick<CloudFormationEngineOptions, "sts" | "cloudFormation">;

/** Credentials come from the AWS SDK's default chain, never from a flag. */
function sdkClients(region: string): AwsClients {
  return {
    sts: new STSClient({ region }),
    cloudFormation: (credentials, stackRegion) =>
      new CloudFormationClient({ region: stackRegion, credentials }),
  };
}

/**
 * The operator account is read once here, so a host without usable credentials refuses to
 * start instead of failing its first deployment.
 */
export async function connectCloudHosting(
  repositoryRoot: string,
  dataDirectory: string,
  region: string,
  clients: AwsClients = sdkClients(region),
): Promise<CloudHosting> {
  const externalIdPath = join(privateDirectory(dataDirectory), "competitor-external-id");
  const externalId = persistentKey(externalIdPath);
  const { Account: operatorAccountId } = await clients.sts
    .send(new GetCallerIdentityCommand({}))
    .catch((error: unknown) => {
      throw new Error(
        `--aws-region needs usable AWS credentials. STS GetCallerIdentity failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
  if (!operatorAccountId) throw new Error("STS GetCallerIdentity returned no account ID.");
  return {
    region,
    operatorAccountId,
    externalId,
    externalIdPath,
    verify: async (accountId, roleName) => {
      await assumeRoleWithExternalId(
        { sts: clients.sts },
        {
          roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
          jobId: accountId,
          externalId,
          sessionNamePrefix: "tenkacloud-host-verify-",
        },
      );
    },
    engine: (team) =>
      new CloudFormationEngine(repositoryRoot, {
        ...clients,
        region,
        externalId,
        operatorAccountId: async () => operatorAccountId,
        team,
        sleep: (milliseconds) => sleep(milliseconds),
        pollIntervalMs: 5_000,
        timeoutMs: 60 * 60_000,
      }),
  };
}
