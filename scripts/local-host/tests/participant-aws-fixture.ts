import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssumeRoleCommand, type AssumeRoleCommandInput, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { id } from "../auth";
import { CloudFormationEngine } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { startHttpHost } from "../http";
import type { Job } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { TEST_ORGANIZER_PASSWORD } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
type Stage = "competitor" | "participant_viewer" | "federation" | "token_body";

function roleStage(input: AssumeRoleCommandInput) {
  return input.RoleArn?.endsWith("/TenkaCloud-CompetitorDeploy-Role")
    ? "competitor"
    : "participant_viewer";
}

export async function createParticipantAwsFixture(
  options: { withAws?: boolean; staticRoot?: string } = {},
) {
  const directory = createTemporaryDirectory(root, "tenka-console-");
  const database = join(directory, "host.sqlite");
  const store = new HostStore(new Database(database));
  // Static UI rehearsals use key auth; historical role tests remain account based.
  const organizerKey = options.staticRoot ? store.ensureLocalOrganizerKey().key : undefined;
  const expiry = new Date(Date.now() + 3_500_000);
  const calls: { stage: Stage; input: AssumeRoleCommandInput }[] = [];
  const federation: { url: string; init: RequestInit }[] = [];
  const logs: unknown[] = [];
  const controls: {
    before?: (stage: Stage) => Promise<void>;
    failed?: Stage;
    missing?: "competitor" | "participant_viewer";
    expired?: "competitor" | "participant_viewer";
    badToken?: unknown;
    federationStatus?: number;
  } = {};
  const operatorSts = () => {
    const client = new STSClient({
      region: "ap-northeast-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    spyOn(client, "send").mockImplementation(async (command) => {
      if (!(command instanceof AssumeRoleCommand)) throw new Error("Unexpected AWS request");
      const stage = roleStage(command.input);
      calls.push({ stage, input: command.input });
      await controls.before?.(stage);
      if (controls.failed === stage) throw new Error("LEAKED_SECRET_AND_TOKEN_URL");
      return {
        $metadata: {},
        Credentials:
          controls.missing === stage
            ? undefined
            : {
                AccessKeyId: `${stage}-access`,
                SecretAccessKey: `${stage}-secret`,
                SessionToken: `${stage}-token`,
                Expiration: controls.expired === stage ? new Date(0) : expiry,
              },
      };
    });
    return client;
  };
  const cloud = new CloudFormationEngine(root, {
    region: "ap-northeast-1",
    externalId: "host-external-id-0123456789",
    operatorAccountId: async () => "999999999999",
    sts: operatorSts(),
    cloudFormation: () => {
      throw new Error("No CloudFormation call is permitted in access tests");
    },
    federationFetch: async (url, init) => {
      federation.push({ url, init });
      await controls.before?.("federation");
      if (controls.failed === "federation") throw new Error("LEAKED_SECRET_AND_TOKEN_URL");
      const response = Response.json(controls.badToken ?? { SigninToken: "viewer-signin-token" }, {
        status: controls.federationStatus ?? 200,
      });
      const read = response.json.bind(response);
      response.json = async () => {
        await controls.before?.("token_body");
        return read();
      };
      return response;
    },
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  const engine = new CompetitionEngine(
    root,
    directory,
    false,
    options.withAws === false ? undefined : cloud,
  );
  const service = new HostingService(store, engine, "host-test-key", Date.now, (message) =>
    logs.push(message),
  );
  const participant = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: options.staticRoot ?? directory,
    service,
    log: (error) => logs.push(error),
  });
  const admin = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory,
    service,
    log: (error) => logs.push(error),
  });
  async function close() {
    await Promise.all([participant.close(), admin.close()]);
    await service.drain();
    store.close();
    removeTemporaryDirectory(root, directory);
  }
  async function request(origin: string, path: string, token = "", method = "GET", body?: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: z.record(z.unknown()).parse(await response.json()),
    };
  }
  const login = await request(
    admin.origin,
    organizerKey ? "/api/host/login" : "/api/host/bootstrap",
    "",
    "POST",
    organizerKey
      ? { key: organizerKey }
      : { key: "host-test-key", username: "fixture-admin", password: TEST_ORGANIZER_PASSWORD },
  );
  const token = z.string().parse(login.body.idToken);
  const eventId = id();
  const definition = cloud.catalog()[0];
  if (!definition) throw new Error("Missing reviewed hello-world catalog entry");
  store.putEvent({
    eventId,
    name: "AWS access",
    status: "READY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startsAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [definition],
  });
  const teams = ["111111111111", "222222222222"].map((accountId, index) => {
    const team = {
      teamId: id(),
      eventId,
      internalSlug: `team-${index}`,
      displayName: `Team ${index}`,
      loginKey: `team-key-${index}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId, roleName: "TenkaCloud-CompetitorDeploy-Role" },
    };
    store.putTeam(team);
    const job: Job = {
      jobId: id(),
      eventId,
      teamId: team.teamId,
      problemId: definition.problemId,
      definition: definition.definition,
      offset: 0,
      status: "COMPLETE",
      unit: JSON.stringify({
        kind: "cloudformation",
        accountId,
        roleArn: `arn:aws:iam::${accountId}:role/TenkaCloud-CompetitorDeploy-Role`,
        region: "ap-northeast-1",
        stackName: `team-${index}`,
        outputs: {
          ParticipantViewerRoleArn: `arn:aws:iam::${accountId}:role/hello-world-viewer-${index}`,
          ParameterValue: "private-flag",
        },
      }),
    };
    store.putJob(job);
    return { team, job };
  });
  const alpha = teams[0];
  const beta = teams[1];
  if (!alpha || !beta) throw new Error("Missing test teams");
  return {
    origin: participant.origin,
    get organizerKey() {
      if (!organizerKey) throw new Error("This fixture is not in key-only browser mode.");
      return organizerKey;
    },
    close,
    store,
    service,
    eventId,
    alpha,
    beta,
    expiry,
    calls,
    federation,
    logs,
    controls,
    get: (path: string, key = alpha.team.loginKey) => request(participant.origin, path, key),
    access: (
      kind: "console" | "cli" = "console",
      jobId = alpha.job.jobId,
      key = alpha.team.loginKey,
    ) =>
      request(
        participant.origin,
        `/api/portal/me/${kind === "console" ? "console-signin-url" : "cli-credentials"}?jobId=${jobId}`,
        key,
      ),
    admin: (path: string, method = "POST", body: unknown = {}) =>
      request(admin.origin, `/api/events/${eventId}${path}`, token, method, body),
  };
}
