import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { downloadCatalog } from "../../problem-pack/downloaded-catalog";
import { assertComposePolicy } from "../container/compose-policy";
import { loadContainerProblem } from "../container/manifest";
import { DockerHostingEngine } from "../docker-engine";
import { requiredNetworkValue } from "../local-network";
import { normalizePublicServices } from "../network-publication";
import { networkEngineFixture } from "./network-engine-fixture";

const hardened = {
  networks: ["lab"],
  cap_drop: ["ALL"],
  read_only: true,
  security_opt: ["no-new-privileges:true"],
  mem_limit: "128m",
  cpus: 0.25,
  pids_limit: 64,
};

function writeConsoleLab(catalogDir: string): string {
  const directory = join(catalogDir, "challenges/team-console-lab");
  mkdirSync(join(directory, "local"), { recursive: true });
  writeFileSync(
    join(directory, "metadata.json"),
    JSON.stringify({
      id: "team-console-lab",
      name: "Team attack lab",
      category: "Challenge",
      status: "ready",
      difficulty: 1,
      estimatedDuration: "20m",
      description: "A team attack container with an explicitly published Web service.",
      shortDescription: "A team attack container and a published Web service.",
      tags: ["network"],
      learningGoals: ["Verify private-team and published-service boundaries"],
      exposedPorts: [{ port: 18081, name: "Verifier (private controller only)" }],
      runtime: {
        provider: "docker",
        engine: "compose",
        entry: "local/docker-compose.yml",
        verifyUrl: "http://127.0.0.1:18081/verify",
        terminal: { service: "attack" },
        publicServices: [
          {
            id: "web",
            service: "web",
            port: 8080,
            purpose: "競技用 Web",
            applicationProtocol: "http",
          },
        ],
      },
      scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
    }),
  );
  for (const readme of ["README.md", "README.ja.md"])
    writeFileSync(join(directory, readme), "# Lab\n");
  writeFileSync(join(directory, "local/Dockerfile"), "FROM scratch\n");
  const build = (target: string) => ({ context: ".", dockerfile: "Dockerfile", target });
  writeFileSync(
    join(directory, "local/docker-compose.yml"),
    stringify({
      services: {
        attack: { build: build("participant"), ...hardened },
        web: { build: build("web"), ...hardened },
        verifier: {
          build: build("verifier"),
          ...hardened,
          networks: ["grading"],
          ports: ["127.0.0.1:18081:8081"],
        },
      },
      networks: { lab: { internal: true }, grading: { internal: true } },
    }),
  );
  return directory;
}

test("explicit immutable catalog acquisition loads a console lab through the normal schema and Compose policy", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-console-catalog-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/console.git", ref: "a".repeat(40) }],
      },
      { fetcher: (request) => void writeConsoleLab(request.destinationDir) },
    );
    const engine = new DockerHostingEngine(root, join(root, "data"));
    expect(engine.catalog().map((item) => item.problemId)).toEqual(["team-console-lab"]);
    const directory = writeConsoleLab(join(root, "source"));
    const problem = loadContainerProblem(directory);
    expect(problem.terminal?.service).toBe("attack");
    expect(problem.publicServices).toEqual([
      { id: "web", service: "web", port: 8080, purpose: "競技用 Web", applicationProtocol: "http" },
    ]);
    const composePath = join(directory, "local/docker-compose.yml");
    const text = readFileSync(composePath, "utf8");
    expect(() => assertComposePolicy(text, { problemDir: directory, composePath })).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP browser capability is explicit and cannot be an arbitrary protocol or selector", () => {
  const service = {
    id: "web",
    service: "web",
    port: 8080,
    purpose: "Test",
    applicationProtocol: "http" as const,
  };
  expect(normalizePublicServices([service])).toEqual([service]);
  expect(() => normalizePublicServices([{ ...service, applicationProtocol: "https" }])).toThrow();
  expect(() => normalizePublicServices([{ ...service, url: "http://example.test" }])).toThrow();
});

test("real engine resolves only current HTTP publications in the same event from verified endpoints", async () => {
  const f = networkEngineFixture();
  try {
    const own = f.add("requester");
    const publisher = f.add("publisher", 1, 0, true);
    const tcp = f.add("tcp", 1);
    await Promise.all([own.admitted, publisher.admitted, tcp.admitted]);
    f.guard.endpoints = (plan, service, port) => [
      { segment: requiredNetworkValue(plan.segments[0]), service, port, addresses: ["127.0.0.1"] },
    ];
    const context = {
      event: f.store.event("event"),
      team: f.store.team("requester"),
      jobs: [own.job],
      now: 1000,
    };
    const target = {
      teamId: "publisher",
      problemId: publisher.job.problemId,
      serviceId: "public-0",
    };
    const resolved = await f.engine.publishedWebTarget(context, own.job.problemId, target);
    expect(resolved.address).toBe("127.0.0.1");
    expect(resolved.port).toBe(8000);
    expect(resolved.job.jobId).toBe("publisher");
    await expect(
      f.engine.publishedWebTarget(context, own.job.problemId, { ...target, teamId: "tcp" }),
    ).rejects.toThrow("not an HTTP service");
    f.store.putJob({ ...publisher.job, eventId: "other-event" });
    await expect(f.engine.publishedWebTarget(context, own.job.problemId, target)).rejects.toThrow(
      "not currently published",
    );
  } finally {
    await f.close();
  }
});

test("Web endpoint resolution rejects publisher replacement across the asynchronous network view boundary", async () => {
  const f = networkEngineFixture();
  try {
    const own = f.add("requester");
    const publisher = f.add("publisher", 1);
    await Promise.all([own.admitted, publisher.admitted]);
    const context = {
      event: f.store.event("event"),
      team: f.store.team("requester"),
      jobs: [own.job],
      now: 1000,
    };
    f.engine.networkView = async () => {
      f.store.putJob({ ...publisher.job, deployedAt: 2000 });
      return {
        supported: true,
        declared: [],
        shared: [
          {
            teamId: "publisher",
            problemId: publisher.job.problemId,
            serviceId: "public-0",
            purpose: "Test",
            addresses: ["127.0.0.1"],
            port: 8000,
            protocol: "tcp",
          },
        ],
      };
    };
    await expect(
      f.engine.publishedWebTarget(context, own.job.problemId, {
        teamId: "publisher",
        problemId: publisher.job.problemId,
        serviceId: "public-0",
      }),
    ).rejects.toThrow("generation changed");
  } finally {
    await f.close();
  }
});
