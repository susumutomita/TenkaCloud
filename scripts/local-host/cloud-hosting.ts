import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { assumeRoleWithExternalId } from "../lib/assume-role";
import { CloudFormationEngine, type CloudFormationEngineOptions } from "./cloudformation-engine";
import { hasDatabaseState, persistentKey, privateDirectory } from "./files";
import { definitionKind, type Job, type Team } from "./model";

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

/** No AWS-enabled marker is stored; only retained AWS records prove prior use. */
function hasAwsState(databasePath: string): boolean {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(({ name }) => name);
    if (
      tables.includes("host_accounts") &&
      database.query("SELECT 1 FROM host_accounts LIMIT 1").get()
    )
      return true;
    if (!tables.includes("host_jobs")) return false;
    return database
      .query<{ body: string }, []>("SELECT body FROM host_jobs")
      .all()
      .some(
        ({ body }) => definitionKind((JSON.parse(body) as Job).definition) === "cloudformation",
      );
  } finally {
    database.close();
  }
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
  const directory = privateDirectory(dataDirectory);
  const databasePath = join(directory, "hosting.sqlite");
  const existingState = hasDatabaseState(databasePath);
  // The CLI connects AWS before starting the HTTP host. Reject a partial restore here too,
  // before creating an ExternalId or contacting STS.
  if (existingState) persistentKey(join(directory, "host-key"), false);
  const externalIdPath = join(directory, "competitor-external-id");
  // A present key needs no SQLite inspection. Still require it when state exists, so
  // removal between this check and opening the key cannot enable replacement.
  const allowCreate = !existingState || (!existsSync(externalIdPath) && !hasAwsState(databasePath));
  const externalId = persistentKey(externalIdPath, allowCreate);
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
