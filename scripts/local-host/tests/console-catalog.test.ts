import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { downloadCatalog } from "../../problem-pack/downloaded-catalog";
import { assertComposePolicy } from "../container/compose-policy";
import { loadContainerProblem } from "../container/manifest";
import { verifySubmission } from "../container/verify-client";
import { DockerHostingEngine } from "../docker-engine";
import { requiredNetworkValue } from "../local-network";
import { normalizePublicServices } from "../network-publication";
import { networkEngineFixture } from "./network-engine-fixture";

const repository = resolve(import.meta.dirname, "../../..");

test("reference verifier judges the platform submission envelope and refuses malformed bodies", async () => {
  let payload = "";
  await verifySubmission(
    "http://127.0.0.1:18081/verify",
    "synthetic-answer",
    { teamId: "team", problemId: "team-console-lab" },
    {
      fetchImpl: async (_url, init) => {
        payload = String(init.body);
        return Response.json({ correct: false });
      },
    },
  );
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-c",
      `
import io, json, os, runpy, sys
os.environ["FLAG_SEED"] = "synthetic-seed"
sys.argv = ["service.py", "verifier"]
scope = runpy.run_path(sys.argv_path)
handler_type = scope["Handler"]
envelope = json.loads(sys.stdin.read())
assert envelope["submission"] == "synthetic-answer"
for value, expected in [(dict(envelope, submission=scope["flag"]), True), (envelope, False), ([], None)]:
    handler = object.__new__(handler_type)
    encoded = json.dumps(value).encode()
    handler.headers = {"Content-Length": str(len(encoded))}
    handler.path = "/verify"
    handler.rfile = io.BytesIO(encoded)
    replies = []
    handler.send = lambda payload, status=200: replies.append((payload, status))
    handler.do_POST()
    assert replies == [({"correct": expected}, 200)] if expected is not None else replies == [({"error": "invalid request"}, 400)]
`.replace(
        "scope = runpy.run_path(sys.argv_path)",
        `scope = runpy.run_path(${JSON.stringify(join(repository, "packs/console-team-lab/challenges/team-console-lab/local/service.py"))})`,
      ),
    ],
    { input: payload, encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("explicit immutable catalog acquisition loads the console lab through the normal schema and Compose policy", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-console-catalog-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/console.git", ref: "a".repeat(40) }],
      },
      {
        fetcher: (request) => {
          cpSync(join(repository, "packs/console-team-lab"), request.destinationDir, {
            recursive: true,
          });
        },
      },
    );
    const engine = new DockerHostingEngine(root, join(root, "data"));
    const catalog = engine.catalog();
    expect(catalog.map((item) => item.problemId)).toEqual(["team-console-lab"]);
    const directory = join(repository, "packs/console-team-lab/challenges/team-console-lab");
    const problem = loadContainerProblem(directory);
    expect(problem.terminal?.service).toBe("attack");
    expect(problem.publicServices).toEqual([
      { id: "web", service: "web", port: 8080, purpose: "競技用 Web", applicationProtocol: "http" },
    ]);
    const composePath = join(directory, "local/docker-compose.yml");
    const text = readFileSync(composePath, "utf8");
    expect(() => assertComposePolicy(text, { problemDir: directory, composePath })).not.toThrow();
    const compose = parse(text);
    for (const service of Object.values(compose.services) as Record<string, unknown>[]) {
      expect(service.cap_drop).toEqual(["ALL"]);
      expect(service.read_only).toBe(true);
      expect(service.privileged).toBeUndefined();
      expect(service.network_mode).toBeUndefined();
      expect(service.volumes).toBeUndefined();
      expect(service.mem_limit).toBeDefined();
      expect(service.cpus).toBeDefined();
      expect(service.pids_limit).toBeDefined();
    }
    expect(compose.services.attack.ports).toBeUndefined();
    expect(compose.services.web.ports).toBeUndefined();
    expect(compose.services.db.ports).toBeUndefined();
    expect(compose.networks.lab.internal).toBe(true);
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
