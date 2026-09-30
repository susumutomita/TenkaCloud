import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { assertHostingModule, narrowCatalog } from "../browser-metadata";
import { connectCloudHosting } from "../cloud-hosting";
import { CompetitionEngine } from "../competition-engine";
import { parseOptions } from "../options";
import { HostingService } from "../service";
import { digest, HostStore } from "../store";
import { FakeAws, OPERATOR_ACCOUNT } from "./fake-aws";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "tenka-cloud-hosting-"));
  directories.push(directory);
  return directory;
}

test("--aws-region enables cloud problems and must name a standard-partition region", () => {
  expect(parseOptions(["--aws-region", "ap-northeast-1"], root).awsRegion).toBe("ap-northeast-1");
  expect(parseOptions(["--aws-region", "us-east-2"], root).awsRegion).toBe("us-east-2");
  expect("awsRegion" in parseOptions([], root)).toBe(false);
  for (const region of ["tokyo", "us-gov-west-1", "cn-north-1", "us-isob-east-1"])
    expect(() => parseOptions(["--aws-region", region], root)).toThrow(
      `--aws-region ${region} is not a region of the standard AWS partition, such as ap-northeast-1.`,
    );
});

test("version 1 host sessions are revoked while account-registry data remains readable", () => {
  const path = join(temporary(), "legacy.sqlite");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE host_schema(version INTEGER NOT NULL) STRICT;
    INSERT INTO host_schema VALUES (1);
    CREATE TABLE host_sessions(token_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL) STRICT;
  `);
  const now = Date.now();
  const legacyInsert = database.prepare(
    "INSERT INTO host_sessions(token_hash,refresh_hash,expires) VALUES (?,?,?)",
  );
  legacyInsert.run(digest("old-admin-token"), digest("old-refresh"), now + 60_000);
  legacyInsert.finalize();
  const migrated = new HostStore(database);
  expect(() => migrated.authenticateAdmin("old-admin-token", now)).toThrow(
    "Host session expired or invalid.",
  );
  expect(migrated.accounts()).toEqual([]);
  migrated.close();
  const reopened = new HostStore(new Database(path));
  expect(() => reopened.authenticateAdmin("old-admin-token", now)).toThrow(
    "Host session expired or invalid.",
  );
  reopened.close();
});

test("the ExternalId is one private key file, and the operator account is read once per start", async () => {
  const data = temporary();
  const aws = new FakeAws();
  const clients = { sts: aws.sts as never, cloudFormation: aws.cloudFormation as never };
  const hosting = await connectCloudHosting(root, data, "ap-northeast-1", clients);
  const path = join(data, "competitor-external-id");
  expect(hosting.externalIdPath).toBe(path);
  expect(hosting.externalId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(readFileSync(path, "utf8")).toBe(`${hosting.externalId}\n`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(hosting.operatorAccountId).toBe(OPERATOR_ACCOUNT);

  const store = new HostStore(new Database(join(data, "host.sqlite")));
  try {
    const engine = new CompetitionEngine(
      root,
      data,
      true,
      hosting.engine((job) => store.team(job.teamId)),
    );
    const service = new HostingService(store, engine, HOST_KEY);
    service.accountConnection = hosting;
    const token = await bootstrapOrganizer(service, HOST_KEY);
    for (const awsAccountId of ["111111111111", "222222222222"]) {
      await service.admin(
        apiRequest({
          method: "POST",
          path: "/admin/competitor-accounts",
          token,
          body: { awsAccountId },
        }),
      );
      await service.admin(
        apiRequest({
          method: "POST",
          path: `/admin/competitor-accounts/${awsAccountId}/verify`,
          token,
        }),
      );
    }
    const created = await service.admin(
      apiRequest({
        method: "POST",
        path: "/events",
        token,
        body: {
          name: "wiring",
          teams: [
            { internalSlug: "alpha", awsAccountId: "111111111111" },
            { internalSlug: "beta", awsAccountId: "222222222222" },
          ],
          problems: [{ problemId: "hello-world" }],
        },
      }),
    );
    const { eventId } = created.body as { eventId: string };
    await service.admin(apiRequest({ method: "POST", path: `/events/${eventId}/deploy`, token }));
    await service.drain();
    expect(store.jobs(eventId).map((job) => job.status)).toEqual(["COMPLETE", "COMPLETE"]);
  } finally {
    store.close();
  }
  expect(aws.identityCalls).toBe(1);
  expect(aws.assumed.map((input) => input.ExternalId)).toContain(hosting.externalId);
  expect(aws.assumed.every((input) => input.ExternalId === hosting.externalId)).toBe(true);
  expect(
    aws.created.map(
      (input) =>
        input.Parameters?.find((parameter) => parameter.ParameterKey === "TenkaCloudAccountId")
          ?.ParameterValue,
    ),
  ).toEqual([OPERATOR_ACCOUNT, OPERATOR_ACCOUNT]);

  const again = await connectCloudHosting(root, data, "ap-northeast-1", clients);
  expect(again.externalId).toBe(hosting.externalId);
  const refused = {
    ...clients,
    sts: {
      send: async () => {
        throw new Error("The security token included in the request is invalid.");
      },
    },
  };
  await expect(connectCloudHosting(root, data, "ap-northeast-1", refused)).rejects.toThrow(
    "--aws-region needs usable AWS credentials. STS GetCallerIdentity failed: The security token included in the request is invalid.",
  );
  writeFileSync(path, "tampered\n");
  await expect(connectCloudHosting(root, data, "ap-northeast-1", clients)).rejects.toThrow(
    "Invalid competitor-external-id file; refusing to replace it.",
  );
});

test("both browser catalogs carry reviewed hello-world metadata, and never its template", () => {
  const catalog = `import.meta.glob("../../../../problems/*/*/metadata.json");
import.meta.glob("../../../../problems/*/*/*.yaml");`;
  const participant = narrowCatalog(catalog, "/repo/apps/participant-portal/src/data/problems.ts");
  const hostConsole = narrowCatalog(
    catalog,
    "/repo/apps/application-admin-console/src/data/problems.ts",
  );
  expect(
    participant,
  ).toBe(`import.meta.glob("../../../../problems/{challenges/sqli-demo,challenges/hello-world,battles/ac26-crypto-battle}/metadata.json");
import.meta.glob("../../../../problems/challenges/sqli-demo/__local_host_empty__/*.yaml");`);
  expect(
    hostConsole,
  ).toBe(`import.meta.glob("../../../../problems/{challenges/sqli-demo,challenges/hello-world,battles/ac26-crypto-battle}/metadata.json");
import.meta.glob("../../../../problems/challenges/sqli-demo/__local_host_empty__/*.yaml");`);
  expect(() =>
    assertHostingModule("/repo/problems/challenges/hello-world/metadata.json"),
  ).not.toThrow();
  expect(() => assertHostingModule("/repo/problems/challenges/hello-world/template.yaml")).toThrow(
    "Unreviewed problem content entered the hosting bundle: /repo/problems/challenges/hello-world/template.yaml",
  );
});

const EMPTY_DESCRIBE = new TextEncoder().encode(
  '<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><DescribeStacksResult><Stacks/></DescribeStacksResult><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></DescribeStacksResponse>',
);

/** Answers every request locally, so the real SDK client below never reaches AWS. */
const localResponses = {
  handle: async () => ({
    response: { statusCode: 200, headers: { "content-type": "text/xml" }, body: EMPTY_DESCRIBE },
  }),
};

/** The real SDK client as `cloud-hosting.ts` builds it; counts credential fetches. */
function countingClient(lifetimeMs: number) {
  let fetches = 0;
  const client = new CloudFormationClient({
    region: "ap-northeast-1",
    credentials: async () => {
      fetches += 1;
      return {
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date(Date.now() + lifetimeMs),
      };
    },
    requestHandler: localResponses as never,
  });
  return {
    fetches: () => fetches,
    describe: () => client.send(new DescribeStacksCommand({ StackName: "tc-hello-world-alpha" })),
  };
}

test("the SDK reuses competitor credentials and fetches new ones as they near expiry", async () => {
  const fresh = countingClient(15 * 60_000);
  await fresh.describe();
  await fresh.describe();
  expect(fresh.fetches()).toBe(1);

  const expiring = countingClient(4 * 60_000);
  await expiring.describe();
  const beforeSecondRequest = expiring.fetches();
  await expiring.describe();
  expect(expiring.fetches()).toBeGreaterThan(beforeSecondRequest);
});
