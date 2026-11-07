import { strict as assert } from "node:assert";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import { z } from "zod";
import { buildShellExport } from "../../../apps/participant-portal/src/components/cli-credentials-export";
import { startSimulatorFixture } from "./simulator-fixture";
import {
  fixtureShellOutput,
  SimulatorFixtureError,
  waitForFixtureOperation,
} from "./simulator-fixture-process";

const jobSchema = z.object({ jobId: z.string(), status: z.string() });
const eventSchema = z.object({
  eventId: z.string(),
  teams: z.array(z.object({ teamLoginKey: z.string() })).min(1),
});
const viewSchema = z.object({
  problems: z.array(
    z.object({
      problemId: z.string(),
      score: z.number(),
      stackOutputs: z.record(z.string(), z.string()),
      accessCapabilities: z.array(z.string()),
    }),
  ),
});
const credentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string(),
  expiration: z.string(),
  region: z.string(),
  awsAccountId: z.string(),
  simulator: z.literal(true),
  endpointUrl: z.string(),
});
const logSchema = z.object({ entries: z.array(z.object({ message: z.string() })) });

type Fixture = Awaited<ReturnType<typeof startSimulatorFixture>>;
type Host = Awaited<ReturnType<Fixture["startHost"]>>;

async function request(
  origin: string,
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, "Host HTTP operation failed.");
  return response.json() as Promise<unknown>;
}

async function login(host: Host): Promise<string> {
  const response = await fetch(`${host.adminOrigin}/api/host/login`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: host.organizerKey }),
  });
  assert(response.ok, "Organizer login failed.");
  return z.object({ idToken: z.string() }).parse(await response.json()).idToken;
}

async function jobs(host: Host, token: string, eventId: string) {
  const detail = z
    .object({ deploymentsByProblem: z.record(z.string(), z.array(jobSchema)) })
    .parse(await request(host.adminOrigin, `/events/${eventId}`, token));
  const result = detail.deploymentsByProblem["hello-world"];
  assert(result?.length === 1, "Expected exactly one Hello World environment.");
  return result;
}

async function waitForJob(host: Host, token: string, eventId: string, status: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await jobs(host, token, eventId);
    const job = current[0];
    assert(job && job.status !== "FAILED", "Deployment failed.");
    if (job.status === status) return job;
    await Bun.sleep(100);
  }
  throw new Error("Deployment did not reach its expected state.");
}

async function cliRead(
  fixture: Fixture,
  credentials: z.infer<typeof credentialsSchema>,
  name: string,
) {
  const snippet = buildShellExport(credentials);
  const environment = {
    ...fixture.environment,
    PATH: `${dirname(fixture.awsCli)}:${fixture.environment.PATH ?? ""}`,
    HELLO_PARAMETER: name,
  };
  const command =
    'aws ssm get-parameter --name "$HELLO_PARAMETER" --query Parameter.Value --output text';
  const run = async (script: string) => {
    const result = await fixtureShellOutput(`${snippet}\n${script}`, {
      cwd: fixture.root,
      environment,
    });
    return { exit: result.exitCode, output: result.stdout };
  };
  const result = await run(command);
  assert(result.exit === 0, "Original AWS CLI command failed.");
  const refused = await run(`unset AWS_ENDPOINT_URL; ${command}`);
  assert(refused.exit !== 0, "Copied setup did not reject a missing endpoint.");
  return result.output.trim();
}

async function participantRead(
  fixture: Fixture,
  host: Host,
  participantKey: string,
  jobId: string,
) {
  const view = viewSchema.parse(
    await request(host.participantOrigin, "/portal/me", participantKey),
  );
  const problem = view.problems.find((entry) => entry.problemId === "hello-world");
  assert(problem, "Participant Hello World view is missing.");
  assert.deepEqual(problem.accessCapabilities, ["cli-credentials"]);
  assert(!("ParameterConsoleUrl" in problem.stackOutputs), "Real AWS console link was exposed.");
  const name = problem.stackOutputs.ParameterName;
  assert(name, "Parameter name is missing.");
  const response = z
    .object({ credentials: credentialsSchema })
    .parse(
      await request(
        host.participantOrigin,
        `/portal/me/cli-credentials?jobId=${jobId}`,
        participantKey,
      ),
    );
  const credentials = response.credentials;
  assert(credentials.accessKeyId.startsWith("TCSIMASIA"), "Expected native temporary credentials.");
  assert.equal(normalizeSimulatorEndpointUrl(credentials.endpointUrl), fixture.endpoint);
  const client = new SSMClient({
    endpoint: credentials.endpointUrl,
    region: credentials.region,
    maxAttempts: 1,
    credentials: { ...credentials, expiration: new Date(credentials.expiration) },
  });
  try {
    const value = (
      await client.send(new GetParameterCommand({ Name: name }), {
        abortSignal: AbortSignal.timeout(10_000),
      })
    ).Parameter?.Value;
    assert(
      typeof value === "string" && value.startsWith("TC{"),
      "Expected deployed parameter value.",
    );
    assert(!JSON.stringify(view).includes(value), "Participant view disclosed the answer.");
    assert.equal(await cliRead(fixture, credentials, name), value, "CLI and SDK values differ.");
    await assert.rejects(
      client.send(new GetParameterCommand({ Name: "/outside-this-problem/hello" }), {
        abortSignal: AbortSignal.timeout(10_000),
      }),
      (error: unknown) => error instanceof Error && error.name.includes("AccessDenied"),
    );
    return { value, name };
  } finally {
    client.destroy();
  }
}

async function checkLogs(fixture: Fixture, host: Host, participantKey: string, jobId: string) {
  const logs = logSchema.parse(
    await request(host.participantOrigin, `/portal/me/deploy-logs?jobId=${jobId}`, participantKey),
  );
  const client = new CloudFormationClient({
    endpoint: fixture.endpoint,
    region: fixture.region,
    credentials: fixture.operatorCredentials,
    maxAttempts: 1,
  });
  try {
    const stacks =
      (
        await client.send(new DescribeStacksCommand({}), {
          abortSignal: AbortSignal.timeout(10_000),
        })
      ).Stacks ?? [];
    const stack = stacks.find((entry) =>
      entry.Tags?.some((tag) => tag.Key === "tenkacloud:job" && tag.Value === jobId),
    );
    assert(stack?.StackId, "Owned deployed stack is missing.");
    const events =
      (
        await client.send(new DescribeStackEventsCommand({ StackName: stack.StackId }), {
          abortSignal: AbortSignal.timeout(10_000),
        })
      ).StackEvents ?? [];
    assert(events.length > 0, "Native deployment events are missing.");
    const expected = [...events]
      .reverse()
      .sort((a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0))
      .map(
        (event) => `${event.LogicalResourceId} (${event.ResourceType}): ${event.ResourceStatus}`,
      );
    assert.deepEqual(
      logs.entries.map((entry) => entry.message),
      expected,
    );
    return logs.entries.length;
  } finally {
    client.destroy();
  }
}

async function score(host: Host, participantKey: string) {
  const view = viewSchema.parse(
    await request(host.participantOrigin, "/portal/me", participantKey),
  );
  assert.equal(view.problems.find((problem) => problem.problemId === "hello-world")?.score, 95);
}

/** Explicit opt-in integration rehearsal, never an implicit ordinary-CI skip. */
export async function runSimulatorHello(options: { binary: string; awsCli: string }) {
  const fixture = await startSimulatorFixture(options);
  let host: Host | undefined;
  let stage = "make local startup and organizer authentication";
  try {
    host = await fixture.startHost();
    let token = await login(host);
    stage = "account setup and native bootstrap verification";
    await request(host.adminOrigin, "/admin/competitor-accounts", token, "POST", {
      awsAccountId: "000000000000",
      competitorRoleName: "TenkaCloud-SimulatorDeploy-Role",
    });
    await request(
      host.adminOrigin,
      "/admin/competitor-accounts/000000000000/verify",
      token,
      "POST",
    );
    stage = "original Hello World deployment";
    const event = eventSchema.parse(
      await request(host.adminOrigin, "/events", token, "POST", {
        name: "Local Simulator Hello World acceptance",
        teams: [{ internalSlug: "alpha", awsAccountId: "000000000000" }],
        problems: [{ problemId: "hello-world" }],
      }),
    );
    const participantKey = event.teams[0]?.teamLoginKey;
    assert(participantKey, "Participant key is missing.");
    await request(host.adminOrigin, `/events/${event.eventId}/deploy`, token, "POST", {});
    const job = await waitForJob(host, token, event.eventId, "COMPLETE");
    await request(host.adminOrigin, `/events/${event.eventId}/schedule`, token, "PATCH", {
      startNow: true,
    });
    stage = "participant copied setup, CLI and scoped parameter read";
    const parameter = await participantRead(fixture, host, participantKey, job.jobId);
    stage = "grading and persisted results";
    z.object({ kind: z.literal("wrong"), scoreDelta: z.literal(-5) }).parse(
      await request(host.participantOrigin, "/portal/me/submit-flag", participantKey, "POST", {
        problemId: "hello-world",
        flag: "TC{wrong}",
      }),
    );
    z.object({ kind: z.literal("ok"), totalScore: z.literal(95) }).parse(
      await request(host.participantOrigin, "/portal/me/submit-flag", participantKey, "POST", {
        problemId: "hello-world",
        flag: parameter.value,
      }),
    );
    await score(host, participantKey);
    const history = z
      .object({ entries: z.array(z.object({ points: z.number() })) })
      .parse(await request(host.participantOrigin, "/portal/me/score-events", participantKey));
    assert.deepEqual(
      history.entries.map((entry) => entry.points).sort((a, b) => a - b),
      [-5, 100],
    );
    const leaderboard = z
      .object({ entries: z.array(z.object({ score: z.number(), isMyTeam: z.boolean() })) })
      .parse(await request(host.participantOrigin, "/portal/leaderboard", participantKey));
    assert.equal(leaderboard.entries.find((entry) => entry.isMyTeam)?.score, 95);
    stage = "native deployment logs";
    const logCount = await checkLogs(fixture, host, participantKey, job.jobId);
    stage = "graceful restart and score persistence";
    await host.stop();
    host = await fixture.startHost();
    token = await login(host);
    await score(host, participantKey);
    stage = "environment teardown";
    await request(host.adminOrigin, `/events/${event.eventId}`, token, "DELETE");
    await waitForJob(host, token, event.eventId, "DELETED");
    const client = new SSMClient({
      endpoint: fixture.endpoint,
      region: fixture.region,
      credentials: fixture.operatorCredentials,
      maxAttempts: 1,
    });
    try {
      await assert.rejects(
        client.send(new GetParameterCommand({ Name: parameter.name }), {
          abortSignal: AbortSignal.timeout(10_000),
        }),
        (error: unknown) => error instanceof Error && error.name === "ParameterNotFound",
      );
    } finally {
      client.destroy();
    }
    return {
      success: true,
      bun: Bun.version,
      awsCli: fixture.awsCliVersion,
      simulatorBinarySha256: fixture.simulatorBinarySha256,
      servedBuildVerified: true,
      hostBuildFingerprint: fixture.hostBuildFingerprint,
      servedAssetCount: fixture.servedAssetCount,
      catalogDigest: fixture.catalogDigest,
      templateSha256: fixture.templateHash,
      nativeLogCount: logCount,
      score: 95,
      restart: true,
      cleanup: true,
      command: "make local",
      guiVerified: false,
    };
  } catch {
    throw new SimulatorFixtureError(
      `Acceptance failed during ${stage}; private output was withheld.`,
    );
  } finally {
    try {
      await host?.stop();
    } finally {
      await fixture.stop();
    }
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        "simulator-binary": { type: "string" },
        "aws-cli": { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(
        "Usage: bun run test:simulator-hello --simulator-binary /path/to/simulator --aws-cli /path/to/aws",
      );
      console.log(
        "Requires Bun1.4.4, AWSCLI1.46.3, prebuilt UI and the pinned original local catalog. See scripts/local-host/integration/README.md. No downloads or real AWS.",
      );
      process.exit(0);
    }
    if (!values["simulator-binary"] || !values["aws-cli"])
      throw new SimulatorFixtureError(
        "Both --simulator-binary and --aws-cli are required; see --help.",
      );
    console.log(
      JSON.stringify(
        await waitForFixtureOperation(
          runSimulatorHello({
            binary: values["simulator-binary"],
            awsCli: values["aws-cli"],
          }),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    // Never print AWS response bodies, private process output, tokens or submitted values.
    console.error(
      error instanceof SimulatorFixtureError
        ? error.message
        : "Simulator Hello World acceptance failed. Check the documented prerequisites and explicit local inputs; private output was withheld.",
    );
    process.exitCode = 1;
  }
}
