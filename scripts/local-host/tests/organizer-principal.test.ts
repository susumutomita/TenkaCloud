import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomToken } from "../auth";
import { requireOrganizerPermission } from "../organizer-access";
import type { OrganizerIdentityRecord, OrganizerPrincipal } from "../organizer-principal";
import { HostStore } from "../store";

// This assignment also fails CI typecheck if the authenticated capability becomes raw claims again.
const rawClaimsArePrincipal: OrganizerIdentityRecord extends OrganizerPrincipal ? true : false =
  false;

test("raw identity fields cannot stand in for an authenticated principal", () => {
  expect(rawClaimsArePrincipal).toBe(false);
});
test.each(["Admin", "Operator", "Viewer"] as const)(
  "server session authenticates %s before permission checks",
  (role) => {
    const store = new HostStore(new Database(":memory:"));
    const token = randomToken();
    const user = {
      id: "user",
      username: "user",
      role,
      status: "active" as const,
      authVersion: 1,
      passwordHash: Bun.password.hashSync(randomToken(), { algorithm: "argon2id" }),
      createdAt: 1,
    };
    try {
      const identity = store.bootstrap(user);
      store.addSession(token, randomToken(), 100_000, 1, user, identity);
      const principal = store.authenticateAdmin(token, 2);
      expect(principal.role).toBe(role);
      expect(() => requireOrganizerPermission(principal, "read")).not.toThrow();
      if (role === "Viewer")
        expect(() => requireOrganizerPermission(principal, "run-events")).toThrow(
          "Organizer role does not permit",
        );
      else expect(() => requireOrganizerPermission(principal, "run-events")).not.toThrow();
      expect(() => store.authenticateAdmin(randomToken(), 2)).toThrow(
        "Host session expired or invalid",
      );
      expect(() => store.authenticateAdmin(token, 100_001)).toThrow(
        "Host session expired or invalid",
      );
    } finally {
      store.close();
    }
  },
);
