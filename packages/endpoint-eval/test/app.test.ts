import { describe, expect, it } from "vitest";
import { createEvalApp, type EvalAppDeps } from "../src/app.js";
import type { ChallengeDefinition } from "../src/challenge.js";
import { CHALLENGES } from "../src/challenges/index.js";
import { verifyClearCode } from "../src/clear-code.js";
import { InMemoryRunRepository } from "../src/run-store.js";
import { CLOUDFLARE_WORKERS_POLICY } from "../src/target-guard.js";

const CHALLENGE_ID = "cloudflare-api-security-001";
const WORKERS_URL = "https://team.example.workers.dev";
const SECRET = "test-secret";

const json = (o: unknown, status: number): Response =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

/**
 * テスト用の擬似プロフィール Worker。 公開契約を実装する。 `secureAuthz` / `secureInput` /
 * `leakInternals` を切り替えて「全対策済み (= 全 stage pass)」「脆弱 (= 特定 stage fail)」を作る。
 */
interface WorkerOpts {
  secureAuthz?: boolean;
  secureInput?: boolean;
  leakInternals?: boolean;
}
type User = { id: string; name: string; email: string };

function handleGet(
  users: Record<string, User>,
  targetId: string,
  owns: boolean,
  secure: boolean,
): Response {
  if (secure && !owns) return json({ error: "forbidden" }, 403);
  const u = users[targetId];
  return u
    ? json({ id: u.id, name: u.name, email: u.email }, 200)
    : json({ error: "not found" }, 404);
}

function handlePatch(
  users: Record<string, User>,
  targetId: string,
  owns: boolean,
  rawBody: string,
  opts: { authz: boolean; input: boolean },
): Response {
  if (opts.authz && !owns) return json({ error: "forbidden" }, 403);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return opts.input ? json({ error: "bad json" }, 400) : json({ ok: true }, 200);
  }
  const name = (parsed as { name?: unknown }).name;
  if (opts.input && (typeof name !== "string" || name.length === 0 || name.length > 50)) {
    return json({ error: "invalid name" }, 400);
  }
  const u = users[targetId];
  u.name = String(name);
  return json({ id: u.id, name: u.name, email: u.email }, 200);
}

function makeProfileWorker(opts: WorkerOpts = {}): typeof fetch {
  const secureAuthz = opts.secureAuthz ?? true;
  const secureInput = opts.secureInput ?? true;
  const users: Record<string, User> = {
    u_alice: { id: "u_alice", name: "Alice", email: "alice@example.com" },
    u_bob: { id: "u_bob", name: "Bob", email: "bob@example.com" },
  };
  const byToken: Record<string, string> = { tok_alice: "u_alice", tok_bob: "u_bob" };

  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = headers.Authorization?.startsWith("Bearer ")
      ? headers.Authorization.slice(7)
      : undefined;
    const callerId = token ? byToken[token] : undefined;

    if (url.pathname === "/healthz") return json({ status: "ok" }, 200);

    const m = url.pathname.match(/^\/profiles\/([^/]+)$/);
    if (m) {
      const targetId = decodeURIComponent(m[1]);
      if (!callerId) return json({ error: "unauthorized" }, 401);
      const owns = callerId === targetId;
      if (method === "GET") return handleGet(users, targetId, owns, secureAuthz);
      if (method === "PATCH") {
        return handlePatch(users, targetId, owns, (init?.body as string) ?? "", {
          authz: secureAuthz,
          input: secureInput,
        });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (opts.leakInternals) {
      return new Response("Error: stack trace at Object.<anonymous> (node_modules/x)", {
        status: 500,
      });
    }
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function makeDeps(fetchFn: typeof fetch, over: Partial<EvalAppDeps> = {}): EvalAppDeps {
  let counter = 0;
  return {
    repo: new InMemoryRunRepository(),
    challenges: CHALLENGES,
    signingSecret: SECRET,
    fetchFn,
    now: () => 1_000,
    newId: () => `id-${++counter}`,
    newSeed: () => "seed-fixed",
    ...over,
  };
}

async function postJson(app: ReturnType<typeof createEvalApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return { res, data: (await res.json()) as Record<string, unknown> };
}

const STAGE_IDS = [
  "0-deploy",
  "1-input-validation",
  "2-authorization",
  "3-info-disclosure",
  "4-final",
];

describe("createEvalApp — full secure worker passes every stage", () => {
  it("should issue a verifiable clear code for each of the 5 stages", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { res: runRes, data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    expect(runRes.status).toBe(201);
    const runId = run.runId as string;
    expect((run.stages as unknown[]).length).toBe(5);

    for (const stage of STAGE_IDS) {
      const { res, data } = await postJson(app, `/runs/${runId}/evaluations`, {
        stage,
        endpoint: WORKERS_URL,
      });
      expect(res.status).toBe(200);
      expect(data.passed, `stage ${stage} should pass: ${JSON.stringify(data.probes)}`).toBe(true);
      const code = data.clearCode as string;
      expect(code).toBeTruthy();
      const verified = verifyClearCode(code, SECRET, 1_000);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.stage).toBe(stage);
    }
  });

  it("should not expose probe internals in the public stage list", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    expect(JSON.stringify(run.stages)).not.toContain("tok_alice");
    expect(JSON.stringify(run.stages)).not.toContain("/profiles");
  });
});

describe("createEvalApp — vulnerable workers fail the relevant stage", () => {
  it("should fail authorization stage when IDOR is not prevented", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker({ secureAuthz: false })));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { data } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "2-authorization",
      endpoint: WORKERS_URL,
    });
    expect(data.passed).toBe(false);
    expect(data.clearCode).toBeUndefined();
  });

  it("should fail input-validation stage when inputs are not validated", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker({ secureInput: false })));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { data } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "1-input-validation",
      endpoint: WORKERS_URL,
    });
    expect(data.passed).toBe(false);
  });

  it("should fail info-disclosure stage when internals leak", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker({ leakInternals: true })));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { data } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "3-info-disclosure",
      endpoint: WORKERS_URL,
    });
    expect(data.passed).toBe(false);
  });
});

describe("createEvalApp — run lifecycle and validation", () => {
  it("should 404 an unknown challenge and 400 a malformed create body", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    expect((await postJson(app, "/runs", { challengeId: "nope" })).res.status).toBe(404);
    expect((await postJson(app, "/runs", {})).res.status).toBe(400);
  });

  it("should 404 evaluations against an unknown run", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { res } = await postJson(app, "/runs/ghost/evaluations", {
      stage: "0-deploy",
      endpoint: WORKERS_URL,
    });
    expect(res.status).toBe(404);
  });

  it("should 400 a malformed evaluation body and 404 an unknown stage", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    expect((await postJson(app, `/runs/${run.runId}/evaluations`, {})).res.status).toBe(400);
    expect(
      (
        await postJson(app, `/runs/${run.runId}/evaluations`, {
          stage: "99",
          endpoint: WORKERS_URL,
        })
      ).res.status,
    ).toBe(400 + 4); // 404
  });

  it("should reject an endpoint that violates the target policy (SSRF guard)", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { res, data } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "0-deploy",
      endpoint: "https://evil.example.com/",
    });
    expect(res.status).toBe(400);
    expect(String(data.error)).toContain("受理できません");
  });

  it("should issue the same clear code idempotently for a re-passed stage", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const first = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "0-deploy",
      endpoint: WORKERS_URL,
    });
    const second = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "0-deploy",
      endpoint: WORKERS_URL,
    });
    expect(first.data.clearCode).toBe(second.data.clearCode);
  });

  it("should fetch a stored evaluation and 404 a missing one", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { data: ev } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "0-deploy",
      endpoint: WORKERS_URL,
    });
    const got = await app.request(`/runs/${run.runId}/evaluations/${ev.evaluationId}`);
    expect(got.status).toBe(200);
    const missing = await app.request(`/runs/${run.runId}/evaluations/ghost`);
    expect(missing.status).toBe(404);
  });
});

describe("createEvalApp — malformed JSON bodies are rejected, not thrown", () => {
  const malformed = (path: string) =>
    createEvalApp(makeDeps(makeProfileWorker())).request(path, {
      method: "POST",
      body: "{ this is not json",
      headers: { "Content-Type": "application/json" },
    });

  it("should 400 a non-JSON create-run body", async () => {
    expect((await malformed("/runs")).status).toBe(400);
  });

  it("should 400 a non-JSON clear-code verify body", async () => {
    expect((await malformed("/clear-codes/verify")).status).toBe(400);
  });

  it("should 400 a non-JSON evaluation body (after the run is found)", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const res = await app.request(`/runs/${run.runId}/evaluations`, {
      method: "POST",
      body: "{ not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describe("createEvalApp — challenge without run-value generation", () => {
  it("should evaluate a challenge that omits makeRunValues (empty substitutions)", async () => {
    const challenge: ChallengeDefinition = {
      id: "no-values",
      title: "No run values",
      targetPolicy: CLOUDFLARE_WORKERS_POLICY,
      stages: [
        {
          id: "only",
          title: "Only",
          probes: [
            {
              id: "healthz",
              request: { method: "GET", path: "/healthz" },
              expect: { status: 200, bodyIncludes: ["ok"] },
              description: "healthz",
            },
          ],
        },
      ],
    };
    const app = createEvalApp(
      makeDeps(makeProfileWorker(), { challenges: { "no-values": challenge } }),
    );
    const { data: run } = await postJson(app, "/runs", { challengeId: "no-values" });
    const { res, data } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "only",
      endpoint: WORKERS_URL,
    });
    expect(res.status).toBe(200);
    expect(data.passed).toBe(true);
  });
});

describe("createEvalApp — healthz and clear-code verification", () => {
  it("should answer healthz", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("should verify a valid code, reject a tampered one, and 400 a malformed body", async () => {
    const app = createEvalApp(makeDeps(makeProfileWorker()));
    const { data: run } = await postJson(app, "/runs", { challengeId: CHALLENGE_ID });
    const { data: ev } = await postJson(app, `/runs/${run.runId}/evaluations`, {
      stage: "0-deploy",
      endpoint: WORKERS_URL,
    });
    const good = await postJson(app, "/clear-codes/verify", { code: ev.clearCode });
    expect(good.data.valid).toBe(true);

    const bad = await postJson(app, "/clear-codes/verify", { code: `${ev.clearCode}tamper` });
    expect(bad.data.valid).toBe(false);

    expect((await postJson(app, "/clear-codes/verify", {})).res.status).toBe(400);
  });
});
