/** Test-only runtime adapter. Real HTTP and real SQLite, but NOT the Docker
 * adapter or the repository's shared scoring implementation. Used to isolate
 * authentication, durable state, event gates and proxy boundaries. */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { closeServer, json, listen, readBody } from "../http";
import {
  type Context,
  type EngineResult,
  type Job,
  object,
  type RuntimeEngine,
  type SqlDatabase,
} from "../model";

interface Exercise {
  origin: string;
  close(): Promise<void>;
}

export class ExerciseFixture implements RuntimeEngine {
  readonly running = new Map<string, Exercise>();
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  failStart = false;
  failStop = false;
  verifyDelay = 0;
  constructor(private readonly openDatabase: (path: string) => SqlDatabase) {}
  catalog() {
    return [
      {
        problemId: "sqli-demo",
        name: "SQL injection exercise fixture",
        definition: "private-fixture-descriptor",
      },
    ];
  }
  async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    retain(JSON.stringify({ jobId: job.jobId }));
    if (this.failStart) throw new Error("Injected runtime failure; retain ownership.");
    this.starts.push(job.jobId);
    const db = this.openDatabase(":memory:");
    db.exec("CREATE TABLE users (username TEXT, password TEXT, role TEXT)");
    db.prepare("INSERT INTO users VALUES (?,?,?)").run(
      "admin",
      createHash("sha256").update(job.jobId).digest("hex"),
      "admin",
    );
    const flagHash = createHash("sha256").update(`flag:${job.jobId}`).digest("hex").slice(0, 20);
    const flag = `TC{${flagHash}}`;
    const login = (body: string): { status: number; body: unknown } => {
      const params = new URLSearchParams(body);
      // Intentional training vulnerability confined to the test fixture process.
      const username = params.get("username") ?? "";
      const password = params.get("password") ?? "";
      let row: unknown;
      try {
        row = db
          .prepare(`SELECT role FROM users WHERE username='${username}' AND password='${password}'`)
          .get();
      } catch {
        row = undefined;
      }
      return row ? { status: 200, body: { flag } } : { status: 401, body: { ok: false } };
    };
    const verify = async (body: string): Promise<{ status: number; body: unknown }> => {
      if (this.verifyDelay) await new Promise((accept) => setTimeout(accept, this.verifyDelay));
      return { status: 200, body: { correct: object(JSON.parse(body)).submission === flag } };
    };
    const route = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
      const key = `${request.method ?? "GET"} ${request.url ?? "/"}`;
      if (key === "GET /healthz") return { status: 200, body: { status: "ok" } };
      if (key === "POST /verify") return verify(await readBody(request));
      if (key === "POST /login") return login(await readBody(request));
      return { status: 404, body: { error: "not_found" } };
    };
    const server = createServer((request, response) => {
      if (request.url === "/" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><form action="/login" method="post"><label>User <input name="username"></label><label>Password <input name="password"></label><button>Sign in</button></form>',
        );
        return;
      }
      route(request)
        .then((result) => json(response, result.status, result.body))
        .catch(() => json(response, 500, { error: "fixture_error" }));
    });
    const origin = await listen(server, "127.0.0.1", 0);
    this.running.set(job.jobId, {
      origin,
      close: async () => {
        await closeServer(server);
        db.close();
      },
    });
  }
  async recover(job: Job): Promise<void> {
    const exercise = this.running.get(job.jobId);
    if (!exercise) throw new Error("Fixture runtime is gone.");
    const response = await fetch(`${exercise.origin}/healthz`);
    if (!response.ok) throw new Error("Fixture runtime is unhealthy.");
    await response.text();
  }
  async stop(job: Job): Promise<void> {
    if (this.failStop) throw new Error("Injected cleanup failure.");
    this.stops.push(job.jobId);
    const exercise = this.running.get(job.jobId) ?? this.paused.get(job.jobId);
    if (exercise) await exercise.close();
    this.running.delete(job.jobId);
    this.paused.delete(job.jobId);
  }
  /** Halted environments keep their per-job database, like Compose volumes survive `stop`. */
  readonly paused = new Map<string, Exercise>();
  readonly pauses: string[] = [];
  readonly resumes: string[] = [];
  /** Keeps an environment operation in flight long enough to observe its serialization. */
  operationDelay = 0;
  async pause(job: Job): Promise<void> {
    if (this.operationDelay) await new Promise((accept) => setTimeout(accept, this.operationDelay));
    const exercise = this.running.get(job.jobId);
    if (!exercise) throw new Error("Fixture runtime is not running.");
    this.pauses.push(job.jobId);
    this.running.delete(job.jobId);
    this.paused.set(job.jobId, exercise);
  }
  async resume(job: Job): Promise<void> {
    const exercise = this.paused.get(job.jobId) ?? this.running.get(job.jobId);
    if (!exercise) throw new Error("Fixture runtime is gone.");
    this.resumes.push(job.jobId);
    this.paused.delete(job.jobId);
    this.running.set(job.jobId, exercise);
  }
  surface(job: Job): string {
    const exercise = this.running.get(job.jobId);
    if (!exercise) throw new Error("Fixture runtime is not running.");
    return exercise.origin;
  }
  async view(context: Context) {
    const snapshot = context.team.snapshot ? object(JSON.parse(context.team.snapshot)) : {};
    return {
      problems: context.event.problems.map((problem) => ({
        problemId: problem.problemId,
        jobId: `local-${problem.problemId}`,
        name: problem.name,
        instructions: "Find the admin flag.",
        writeup: "private-solution",
        i18n: { en: { name: "Exercise", writeup: "private-english-solution" } },
        lifecycle: { status: "running", runtimeKind: "docker" },
        score: context.team.score,
        scoring: {
          kind: "flag",
          points: 100,
          flagSubmitted: snapshot.solved === true,
        },
      })),
    };
  }
  async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const snapshot = context.team.snapshot ? object(JSON.parse(context.team.snapshot)) : {};
    if (snapshot.solved) return this.result(context, snapshot, "already_scored", 0);
    const job = context.jobs.find((candidate) => candidate.problemId === body.problemId);
    if (!job) throw new Error("Unknown fixture problem.");
    const response = await fetch(`${this.surface(job)}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submission: body.flag }),
    });
    const verdict = object(await response.json());
    if (verdict.correct) snapshot.solved = true;
    return this.result(
      context,
      snapshot,
      verdict.correct ? "ok" : "wrong",
      verdict.correct ? 100 : -5,
    );
  }
  async hint(context: Context, _problemId: string, hintId: string): Promise<EngineResult> {
    const snapshot = context.team.snapshot ? object(JSON.parse(context.team.snapshot)) : {};
    const key = `hint:${hintId}`;
    const delta = snapshot[key] ? 0 : -20;
    snapshot[key] = true;
    const result = this.result(context, snapshot, delta ? "ok" : "already_revealed", delta, "hint");
    result.body.content = "Try a SQL comment.";
    return result;
  }
  private result(
    context: Context,
    snapshot: Record<string, unknown>,
    kind: string,
    delta: number,
    source = "flag",
  ): EngineResult {
    const entries = [...context.team.scoreEvents];
    if (kind !== "already_scored" && kind !== "already_revealed")
      entries.unshift({
        jobId: context.jobs[0]?.jobId ?? "",
        problemId: "sqli-demo",
        source: kind === "wrong" ? "flag-wrong" : source,
        points: delta,
        result: kind === "wrong" ? "wrong" : "ok",
        occurredAt: new Date(context.now).toISOString(),
      });
    return {
      status: 200,
      body: {
        kind,
        scoreDelta: delta,
        totalScore: context.team.score + delta,
      },
      snapshot: JSON.stringify(snapshot),
      score: context.team.score + delta,
      completedProblems: snapshot.solved ? 1 : 0,
      scoreEvents: entries,
    };
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.running.values(), ...this.paused.values()].map((exercise) => exercise.close()),
    );
    this.running.clear();
    this.paused.clear();
  }
}
