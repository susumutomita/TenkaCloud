import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Command,
  GetCommandInvocationCommand,
  ListCommandsCommand,
  SendCommandCommand,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";
import { id } from "../auth";
import { AwsDisruptionAdapter } from "../aws-disruption-adapter";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import type { HostedEvent, Job, Problem, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { TEST_ORGANIZER_PASSWORD } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const START = Date.parse("2026-09-30T00:00:00Z");
export const metadata = JSON.parse(
  readFileSync(join(root, "problems/battles/hello-world-battle/metadata.json"), "utf8"),
);

/** Only outbound AWS is replaced; delayed effects survive a thrown send response. */
export class DisruptionAws {
  now = START;
  commands: Command[] = [];
  effects: { at: number; commandId: string; instance: string; running: boolean }[] = [];
  running = new Map<string, boolean>();
  injectDelay = 0;
  timeoutNext = false;
  invisible = false;
  rejectRole = false;
  beforeSend?: () => void;
  externalIds: string[] = [];
  destroyed = 0;
  readonly sts = {
    send: async (command: { input: { ExternalId?: string } }) => {
      if (this.rejectRole) throw new Error("credential material must not escape");
      this.externalIds.push(command.input.ExternalId ?? "");
      this.beforeSend?.();
      this.beforeSend = undefined;
      return {
        Credentials: {
          AccessKeyId: "fixture-access",
          SecretAccessKey: "fixture-secret",
          SessionToken: "fixture-session",
        },
      };
    },
  };
  attempts: unknown[] = [];
  readonly ssm = (config: SSMClientConfig) => {
    this.attempts.push(config.maxAttempts);
    return {
      send: async (command: unknown) => {
        if (command instanceof SendCommandCommand) return this.sendCommand(command);
        if (command instanceof ListCommandsCommand) return this.listCommands(command);
        if (command instanceof GetCommandInvocationCommand) {
          this.applyEffects();
          const stored = this.commands.find((each) => each.CommandId === command.input.CommandId);
          if (!stored || this.invisible) throw new Error("InvocationDoesNotExist");
          return { Status: stored.Status };
        }
        throw new Error("Unexpected AWS call");
      },
      destroy: () => {
        this.destroyed += 1;
      },
    };
  };
  private listCommands(command: ListCommandsCommand) {
    const filter = command.input.Filters?.find((each) => each.key === "InvokedAfter");
    if (!filter?.value) throw new Error("InvokedAfter filter is required");
    const since = Date.parse(filter.value);
    return {
      Commands: this.invisible
        ? []
        : this.commands.filter((each) => (each.RequestedDateTime?.getTime() ?? 0) >= since),
    };
  }
  private sendCommand(command: SendCommandCommand) {
    const commandId = `command-${this.commands.length + 1}`;
    const running =
      command.input.Parameters?.commands?.some((script) => script.includes("start nginx")) ?? false;
    const stored: Command = {
      ...command.input,
      CommandId: commandId,
      RequestedDateTime: new Date(this.now),
      Status: "InProgress",
    };
    this.commands.push(stored);
    for (const instance of command.input.InstanceIds ?? [])
      this.effects.push({
        at: this.now + (running ? 0 : this.injectDelay),
        commandId,
        instance,
        running,
      });
    if (this.timeoutNext) {
      this.timeoutNext = false;
      throw new Error("send timed out after AWS accepted it");
    }
    return { Command: stored };
  }
  applyEffects(): void {
    for (const effect of this.effects.filter((each) => each.at <= this.now)) {
      this.running.set(effect.instance, effect.running);
      const command = this.commands.find((each) => each.CommandId === effect.commandId);
      if (command) command.Status = "Success";
    }
    this.effects = this.effects.filter((each) => each.at > this.now);
  }
  adapter(): AwsDisruptionAdapter {
    return new AwsDisruptionAdapter(
      { sts: this.sts as never, ssm: this.ssm as never },
      "fixture-required-external-id",
    );
  }
}

export async function disruptionFixture(options: { staticRoot?: string } = {}) {
  const directory = createTemporaryDirectory(root, "tenka-disruption-");
  const db = join(directory, "host.sqlite");
  const aws = new DisruptionAws();
  let store = new HostStore(new Database(db));
  // Browser rehearsals use current key-only auth; unit role cases retain legacy accounts.
  const organizerKey = options.staticRoot ? store.ensureLocalOrganizerKey().key : undefined;
  const engine = new CompetitionEngine(root, directory, false);
  engine.disruptionAdapter = () => aws.adapter();
  let service = new HostingService(store, engine, "fixture-host-key", () => aws.now);
  let http: HttpHost;
  let token = "";
  async function api(path: string, method = "GET", body?: unknown, key = token) {
    const response = await fetch(`${http.origin}/api${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function attach() {
    http = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: options.staticRoot ?? directory,
      participantOrigin: "http://127.0.0.1:1",
      service,
    });
    const firstVisit = !store.bootstrapCompleted();
    const body = organizerKey
      ? { key: organizerKey }
      : {
          username: "fixture-admin",
          password: TEST_ORGANIZER_PASSWORD,
          ...(firstVisit ? { key: "fixture-host-key" } : {}),
        };
    const session = await api(firstVisit ? "/host/bootstrap" : "/host/login", "POST", body);
    if (session.status !== (firstVisit ? 201 : 200)) throw new Error("Organizer login failed.");
    token = session.body.idToken;
  }
  await attach();
  const problem: Problem = {
    problemId: "hello-world-battle",
    name: "Hello World Battle",
    runtime: "cloudformation",
    definition: JSON.stringify({ kind: "cloudformation", disruptions: metadata.disruptions }),
  };
  const event: HostedEvent = {
    eventId: id(),
    name: "Disruption fixture",
    status: "READY",
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    startsAt: new Date(START - 1000).toISOString(),
    endsAt: new Date(START + 24 * 3600_000).toISOString(),
    expiresAt: Math.floor((START + 24 * 3600_000) / 1000),
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [problem],
  };
  store.putEvent(event);
  const teams: Team[] = ["111111111111", "222222222222"].map((accountId, index) => ({
    teamId: id(),
    eventId: event.eventId,
    internalSlug: `team-${index}`,
    displayName: `Team ${index}`,
    loginKey: `fixture-team-${index}`,
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
    aws: { accountId, roleName: "TenkaCloud-CompetitorDeploy-Role" },
  }));
  for (const [index, team] of teams.entries()) {
    store.putTeam(team);
    const unit = {
      kind: "cloudformation",
      accountId: team.aws?.accountId,
      roleArn: `arn:aws:iam::${team.aws?.accountId}:role/TenkaCloud-CompetitorDeploy-Role`,
      region: "ap-northeast-1",
      stackId: `arn:aws:cloudformation:ap-northeast-1:${team.aws?.accountId}:stack/fixture/${index}`,
      outputs: { InstanceId: `i-0000000000000000${index}`, Ec2HostHint: `192.0.2.${index + 1}` },
    };
    const job: Job = {
      jobId: id(),
      eventId: event.eventId,
      teamId: team.teamId,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      unit: JSON.stringify(unit),
      deployedAt: START,
    };
    store.putJob(job);
  }
  const path = `/events/${event.eventId}/disruptions`;
  return {
    aws,
    event,
    teams,
    problem,
    api,
    path,
    directory,
    get organizerKey() {
      if (!organizerKey) throw new Error("This fixture is not in key-only browser mode.");
      return organizerKey;
    },
    get origin() {
      return http.origin;
    },
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get token() {
      return token;
    },
    rows: () => service.disruptions.store.executions(event.eventId),
    fire: (extra: Record<string, unknown> = {}) =>
      api(`${path}/fire`, "POST", {
        problemId: problem.problemId,
        disruptionId: "frontend-down",
        scope: "all",
        requestId: "fixture-request-1",
        ...extra,
      }),
    tick: () => service.disruptions.tick(),
    advance: (ms: number) => {
      aws.now += ms;
      aws.applyEffects();
    },
    restart: async () => {
      await http.close();
      store.close();
      store = new HostStore(new Database(db));
      service = new HostingService(store, engine, "fixture-host-key", () => aws.now);
      service.disruptions.recover();
      await attach();
    },
    close: async () => {
      await http.close();
      store.close();
      removeTemporaryDirectory(root, directory);
    },
  };
}
