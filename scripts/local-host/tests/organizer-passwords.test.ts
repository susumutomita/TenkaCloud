import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomToken } from "../auth";
import { apiRequest } from "../bench/state-setup";
import { bunOrganizerPasswords } from "../bun-passwords";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

test("Bun password adapter accepts existing encoded hashes and retains Argon2id defaults", async () => {
  const secret = randomToken();
  const legacy = await Bun.password.hash(secret, { algorithm: "argon2id" });
  expect(await bunOrganizerPasswords.verify(secret, legacy)).toBe(true);
  expect(await bunOrganizerPasswords.verify(randomToken(), legacy)).toBe(false);
  const generated = await bunOrganizerPasswords.hash(secret);
  expect(generated.split("$").slice(1, 4)).toEqual(legacy.split("$").slice(1, 4));
  expect(await Bun.password.verify(secret, generated)).toBe(true);
});

test("an injected password-provider failure leaves organizer bootstrap and state unchanged", async () => {
  const store = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture((path) => new Database(path));
  const key = randomToken();
  const failure = new Error("password provider unavailable");
  const service = new HostingService(store, engine, key, undefined, undefined, undefined, {
    hash: async () => {
      throw failure;
    },
    verify: async () => {
      throw failure;
    },
  });
  try {
    await expect(
      service.admin(
        apiRequest({
          method: "POST",
          path: "/host/bootstrap",
          token: "",
          body: {
            key,
            username: "adapter-check",
            password: randomToken(),
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(store.bootstrapCompleted()).toBe(false);
    expect(store.organizers()).toEqual([]);
  } finally {
    store.close();
    await engine.close();
  }
});
