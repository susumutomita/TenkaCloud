import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load, mergeTag } from "js-yaml";
import { type DockerDefinition, loadDockerCatalog } from "../docker-catalog";
import type { LocalComposeUnit } from "./container-runner";
import { spawnDeclaredTerminal } from "./terminal-shell";

const unit: LocalComposeUnit = {
  problemId: "terminal-lab",
  composePath: "/synthetic/private/compose.yml",
  composeProjectName: "owned-team-alpha",
  projectDirectory: "/synthetic/catalog/local",
  secretEnv: ["FLAG_SEED"],
};
const cli = { command: "docker", prefix: ["compose"], label: "docker compose" } as const;
const handlers = {
  onData: (_chunk: string) => undefined,
  onExit: (_code: number | null) => undefined,
};

test("all 15 declared terminal exercises name a participant build target", () => {
  const catalog = loadDockerCatalog(fileURLToPath(new URL("../../../", import.meta.url)));
  const definitions = catalog
    .map((problem) => JSON.parse(problem.definition) as DockerDefinition)
    .filter((definition) => definition.problem.terminal);
  expect(definitions).toHaveLength(15);
  for (const definition of definitions) {
    const config = load(definition.composeText, { schema: CORE_SCHEMA.withTags(mergeTag) }) as {
      services: Record<string, { build?: { target?: string } }>;
    };
    const name = definition.problem.terminal?.service ?? "";
    expect(config.services[name]?.build?.target).toBe("participant");
  }
});

test("terminal exec uses only owned coordinates, declared service and fixed shell", async () => {
  let authorizationChecks = 0;
  let observed: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  await spawnDeclaredTerminal(
    unit,
    "participant",
    handlers,
    () => {
      authorizationChecks += 1;
    },
    {
      cli,
      inspect: async (_command, args) => {
        expect(args.slice(-3)).toEqual(["config", "--format", "json"]);
        return { services: { participant: { build: { target: "participant" } } } };
      },
      spawn: (command, args, env) => {
        observed = { command, args, env };
        return { write: () => undefined, kill: () => undefined };
      },
    },
  );
  expect(authorizationChecks).toBe(2);
  expect(observed?.command).toBe("docker");
  expect(observed?.args).toEqual([
    "compose",
    "-f",
    unit.composePath,
    "-p",
    unit.composeProjectName,
    "--project-directory",
    unit.projectDirectory ?? "",
    "exec",
    "-T",
    "participant",
    "/bin/sh",
  ]);
  expect(observed?.env.FLAG_SEED).toBe("tenkacloud-local-exec");
  expect(observed?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
});

test("terminal refuses missing/wrong participant stage and revocation during config inspection", async () => {
  let spawns = 0;
  const spawn = () => {
    spawns += 1;
    return { write: () => undefined, kill: () => undefined };
  };
  for (const services of [
    {},
    { participant: { build: { target: "grader" } } },
    { participant: { image: "some-image" } },
  ]) {
    await expect(
      spawnDeclaredTerminal(unit, "participant", handlers, () => undefined, {
        cli,
        inspect: async () => ({ services }),
        spawn,
      }),
    ).rejects.toThrow("participant target");
  }
  let allowed = true;
  await expect(
    spawnDeclaredTerminal(
      unit,
      "participant",
      handlers,
      () => {
        if (!allowed) throw new Error("revoked");
      },
      {
        cli,
        inspect: async () => {
          allowed = false;
          return { services: { participant: { build: { target: "participant" } } } };
        },
        spawn,
      },
    ),
  ).rejects.toThrow("revoked");
  expect(spawns).toBe(0);
});
