import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "../auth";
import { apiRequest } from "../bench/state-setup";
import { cloudFormationCatalog } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { type OrganizerProblemContent, organizerProblemContent } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("browser rehearsal fixture supplies organizer details through the authenticated catalog", async () => {
  const database = new Database(":memory:");
  const store = new HostStore(database);
  const engine = new ExerciseFixture((path) => new Database(path));
  const service = new HostingService(store, engine, randomToken());
  const call = (method: string, path: string, token = "", body: unknown = {}) =>
    service.admin(apiRequest({ method, path, token, body }));
  try {
    await expect(call("GET", "/host/catalog")).rejects.toMatchObject({ status: 401 });
    const { key } = store.ensureLocalOrganizerKey();
    const login = await call("POST", "/host/login", "", { key });
    const { idToken } = login.body as { idToken: string };
    const response = await call("GET", "/host/catalog", idToken);
    const { items } = response.body as { items: { content: OrganizerProblemContent }[] };
    expect(items[0]?.content).toEqual(engine.catalog()[0]?.organizerContent);
    expect(items[0]?.content.description).toContain("synthetic SQL injection");
    expect(items[0]?.content.learningGoals.length).toBeGreaterThan(0);
    const created = await call("POST", "/events", idToken, {
      name: "Browser rehearsal",
      teams: [{ internalSlug: "alpha" }],
      problems: [{ problemId: "sqli-demo" }],
    });
    const { eventId } = created.body as { eventId: string };
    expect(store.event(eventId).problems[0]?.organizerContent).toBeUndefined();
  } finally {
    database.close();
  }
});

test("only organizers receive catalog descriptions and goals from the existing authenticated catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-organizer-catalog-"));
  const database = new Database(":memory:");
  const store = new HostStore(database);
  const engine = new CompetitionEngine(root, directory);
  const service = new HostingService(store, engine, randomToken());
  const call = (method: string, path: string, token = "", body: unknown = {}) =>
    service.admin(apiRequest({ method, path, token, body }));
  try {
    const { key } = store.ensureLocalOrganizerKey();
    await expect(call("GET", "/host/catalog")).rejects.toMatchObject({ status: 401 });
    const login = await call("POST", "/host/login", "", { key });
    const { idToken } = login.body as { idToken: string };
    const response = await call("GET", "/host/catalog", idToken);
    const { items } = response.body as {
      items: { problemId: string; content: OrganizerProblemContent; definition?: unknown }[];
    };
    for (const item of items) {
      expect(Object.keys(item.content).sort()).toEqual(
        item.content.i18n
          ? ["description", "i18n", "learningGoals"]
          : ["description", "learningGoals"],
      );
      if (item.content.i18n?.en)
        expect(
          Object.keys(item.content.i18n.en).every((key) =>
            ["description", "learningGoals"].includes(key),
          ),
        ).toBe(true);
      expect(item.content.description.length).toBeGreaterThan(0);
      expect(item.definition).toBeUndefined();
    }
    const raw = JSON.parse(
      readFileSync(join(root, "problems/challenges/ac26-bridge-clock/metadata.json"), "utf8"),
    );
    expect(items.find((item) => item.problemId === raw.id)?.content).toEqual({
      description: raw.description,
      learningGoals: raw.learningGoals,
      i18n: {
        en: { description: raw.i18n.en.description, learningGoals: raw.i18n.en.learningGoals },
      },
    });
    const created = await call("POST", "/events", idToken, {
      name: "Catalog visibility",
      teams: [{ internalSlug: "alpha" }],
      problems: [{ problemId: raw.id }],
    });
    const { eventId } = created.body as { eventId: string };
    const team = store.teams(eventId)[0];
    if (!team) throw new Error("Expected an event team.");
    await expect(call("GET", "/host/catalog", team.loginKey)).rejects.toMatchObject({
      status: 401,
    });
    expect(store.event(eventId).problems[0]?.organizerContent).toBeUndefined();
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reviewed cloud catalog keeps the same organizer text without including solutions", () => {
  for (const problem of cloudFormationCatalog(root)) {
    expect(Object.keys(problem.organizerContent ?? {}).sort()).toEqual(
      problem.organizerContent?.i18n
        ? ["description", "i18n", "learningGoals"]
        : ["description", "learningGoals"],
    );
    if (problem.organizerContent?.i18n?.en)
      expect(
        Object.keys(problem.organizerContent.i18n.en).every((key) =>
          ["description", "learningGoals"].includes(key),
        ),
      ).toBe(true);
    expect(problem.organizerContent?.description.length).toBeGreaterThan(0);
  }
  expect(organizerProblemContent({ description: "text", learningGoals: [42] })).toBeUndefined();
});

test("English organizer text remains optional and excludes participant solutions", () => {
  expect(organizerProblemContent({ description: "日本語", learningGoals: ["目標"] })).toEqual({
    description: "日本語",
    learningGoals: ["目標"],
  });
  expect(
    organizerProblemContent({
      description: "日本語",
      i18n: {
        en: {
          description: "English",
          learningGoals: ["Goal"],
          instructions: "private",
          writeup: "answer",
        },
      },
    }),
  ).toEqual({
    description: "日本語",
    learningGoals: [],
    i18n: { en: { description: "English", learningGoals: ["Goal"] } },
  });
  expect(organizerProblemContent({ description: "日本語", i18n: { en: null } })).toEqual({
    description: "日本語",
    learningGoals: [],
  });
});
