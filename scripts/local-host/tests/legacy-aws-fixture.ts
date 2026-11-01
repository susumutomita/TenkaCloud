import type {
  FlagStackDefinition,
  StackUnit,
  UptimeStackDefinition,
} from "../cloud-runtime-contract";
import type { HostedEvent, Job, Problem, Team } from "../model";
import { skillCatalog } from "../skill-catalog";
import type { HostStore } from "../store";

/**
 * CloudFormation problems as an older hosting revision pinned them on its events. Local hosting
 * no longer deploys them; these fixtures model the saved state it still has to read and refuse.
 */
const TEMPLATE = "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n";

export const LEGACY_FLAG_STACK: FlagStackDefinition = {
  kind: "cloudformation",
  problemId: "hello-world",
  templateBody: TEMPLATE,
  cfnParameters: {},
  name: "Hello World",
  instructions: "Read the flag from the stack output.",
  disruptions: [],
  phases: [],
  scoreFloor: 0,
  flagOutputKey: "Flag",
  scoring: {
    kind: "flag",
    points: 100,
    wrongAnswerPenalty: 10,
    hints: [{ id: "hint-1", content: "Open the stack outputs.", penalty: 30 }],
  },
};

const UPTIME_SCORING = {
  kind: "uptime-flat",
  endpoints: [
    { slot: "frontend", path: "/", expectStatus: [200] },
    { slot: "api", path: "/healthz", expectStatus: [200] },
  ],
  pointsPerSuccess: 100,
  failurePenalty: -100,
} as const;

export const LEGACY_UPTIME_STACK: UptimeStackDefinition = {
  kind: "cloudformation",
  problemId: "hello-world-battle",
  templateBody: TEMPLATE,
  cfnParameters: {},
  name: "Hello World Battle",
  instructions: "Keep the frontend and API healthy.",
  disruptions: [],
  phases: [],
  endpoints: [
    {
      slot: "frontend",
      default: { from: "cfn-output", key: "FrontendUrl" },
      overridable: true,
      label: "Frontend (nginx)",
    },
    {
      slot: "api",
      default: { from: "cfn-output", key: "ApiUrl" },
      overridable: true,
      label: "API (python http.server)",
    },
  ] as UptimeStackDefinition["endpoints"],
  scoring: UPTIME_SCORING as unknown as UptimeStackDefinition["scoring"],
  hostHintOutputKey: "Ec2HostHint",
};

const UPTIME_SKILLS = [
  {
    skillId: "service.endpoint.probe",
    label: "登録したサービスの1つのエンドポイントの成功probe",
    i18n: { en: { label: "Successful probe of a registered service endpoint" } },
    rule: { source: "uptime", result: "ok" },
  },
];

export function legacyStackProblem(
  definition: FlagStackDefinition | UptimeStackDefinition,
): Problem {
  const body = JSON.stringify(definition);
  const skills =
    definition.scoring.kind === "uptime-flat"
      ? skillCatalog({ skillEvidence: UPTIME_SKILLS, scoring: UPTIME_SCORING }, body)
      : undefined;
  return {
    problemId: definition.problemId,
    name: definition.name,
    definition: body,
    runtime: "cloudformation",
    ...(skills ? { skillCatalog: skills } : {}),
  };
}

export function legacyStackUnit(outputs: Record<string, string> = {}): StackUnit {
  return {
    kind: "cloudformation",
    accountId: "111111111111",
    roleArn: "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
    region: "ap-northeast-1",
    stackName: "tc-legacy-stack",
    stackId: "arn:aws:cloudformation:ap-northeast-1:111111111111:stack/tc-legacy-stack/legacy",
    outputs,
  };
}

/** Write a started legacy event with one team and a running stack job per problem. */
export function seedLegacyAwsEvent(
  store: HostStore,
  options: {
    eventId: string;
    teamId: string;
    now: number;
    problems: readonly Problem[];
    outputs?: Record<string, string>;
    extraProblems?: readonly Problem[];
  },
): { event: HostedEvent; team: Team; jobs: Job[] } {
  const at = new Date(options.now).toISOString();
  const problems = [...options.problems, ...(options.extraProblems ?? [])];
  const event: HostedEvent = {
    eventId: options.eventId,
    name: "Event from an older hosting revision",
    status: "READY",
    createdAt: at,
    updatedAt: at,
    startsAt: at,
    expiresAt: Math.floor(options.now / 1000) + 365 * 24 * 3600,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems,
  };
  const team: Team = {
    teamId: options.teamId,
    eventId: options.eventId,
    internalSlug: "alpha",
    displayName: "alpha",
    loginKey: `legacy-team-login-key-${options.teamId}`,
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
    aws: { accountId: "111111111111", roleName: "TenkaCloud-CompetitorDeploy-Role" },
  };
  const jobs: Job[] = problems.map((problem, index) => ({
    jobId: `${options.eventId.slice(0, 24)}${String(index).padStart(2, "0")}`,
    eventId: options.eventId,
    teamId: options.teamId,
    problemId: problem.problemId,
    definition: problem.definition,
    offset: 0,
    status: "COMPLETE",
    unit:
      problem.runtime === "cloudformation"
        ? JSON.stringify(legacyStackUnit(options.outputs))
        : null,
    deployedAt: options.now,
  }));
  store.transaction(() => {
    store.putEvent(event);
    store.putTeam(team);
    for (const job of jobs) store.putJob(job);
  });
  return { event, team, jobs };
}
