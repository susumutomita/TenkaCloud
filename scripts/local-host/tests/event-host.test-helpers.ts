import { Database } from "bun:sqlite";
import { id, randomToken } from "../auth";
import type { ApiRequest } from "../service";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

export async function eventHostFixture(
  run: (context: {
    store: HostStore;
    service: HostingService;
    token: string;
    eventId: string;
    clock: { now: number };
  }) => Promise<void>,
) {
  const store = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture((path) => new Database(path));
  const clock = { now: 10_000 };
  const { key } = store.ensureLocalOrganizerKey();
  if (!key) throw new Error("A fresh store must issue an organizer key.");
  const token = randomToken();
  store.addSession(token, randomToken(), 100_000, 1, store.verifyLocalOrganizerKey(key));
  const eventId = id(2);
  store.putEvent({
    eventId,
    name: "Existing event",
    status: "READY",
    problems: [],
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    expiresAt: 4102444800,
    endsAt: new Date(9_000).toISOString(),
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
  });
  const service = new HostingService(
    store,
    engine,
    randomToken(),
    () => clock.now,
    () => undefined,
  );
  try {
    await run({ store, service, token, eventId, clock });
  } finally {
    await engine.close();
    store.close();
  }
}

export function eventRequest(path: string, token: string, query = ""): ApiRequest {
  return { path, token, body: undefined, method: "GET", query: new URLSearchParams(query) };
}
