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

test("a server-issued organizer-key session authenticates Admin before permission checks", () => {
  const store = new HostStore(new Database(":memory:"));
  const token = randomToken();
  try {
    const { key } = store.ensureLocalOrganizerKey();
    if (!key) throw new Error("A fresh store must issue an organizer key.");
    store.addSession(token, randomToken(), 100_000, 1, store.verifyLocalOrganizerKey(key));
    const principal = store.authenticateAdmin(token, 2);
    expect(principal).toMatchObject({
      role: "Admin",
      authMethod: "host-key",
      userId: null,
      identityId: null,
    });
    for (const permission of [
      "read",
      "run-events",
      "manage-connections",
      "reveal-team-keys",
    ] as const)
      expect(() => requireOrganizerPermission(principal, permission)).not.toThrow();
    expect(() => store.authenticateAdmin(randomToken(), 2)).toThrow(
      "Host session expired or invalid",
    );
    expect(() => store.authenticateAdmin(token, 100_001)).toThrow(
      "Host session expired or invalid",
    );
  } finally {
    store.close();
  }
});

test.each([
  ["Operator", ["read", "run-events", "reveal-team-keys"]],
  ["Viewer", ["read"]],
] as const)("the permission table keeps the %s role narrower than Admin", (role, allowed) => {
  // Only the permission table is under test here; the store issues no non-Admin principal.
  const principal = {
    userId: null,
    identityId: null,
    role,
    authMethod: "host-key",
  } as unknown as OrganizerPrincipal;
  for (const permission of [
    "read",
    "run-events",
    "manage-connections",
    "reveal-team-keys",
  ] as const)
    if ((allowed as readonly string[]).includes(permission))
      expect(() => requireOrganizerPermission(principal, permission)).not.toThrow();
    else
      expect(() => requireOrganizerPermission(principal, permission)).toThrow(
        "Organizer role does not permit",
      );
});
