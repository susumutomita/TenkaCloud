import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { auditRecordSchema } from "../audit-record";
import { HostStore } from "../store";

test("session constraints retain all supported authentication methods and reject unknown methods", () => {
  const store = new HostStore(new Database(":memory:"));
  try {
    const insert = store.database.prepare(
      "INSERT INTO host_sessions(token_hash,refresh_hash,auth_method,auth_version,issued_at,last_seen,expires) VALUES (?,?,?,1,0,0,1)",
    );
    for (const method of ["host-key", "saml", "local-password"]) {
      expect(() => insert.run(randomUUID(), randomUUID(), method)).not.toThrow();
    }
    expect(() => insert.run(randomUUID(), randomUUID(), "unknown-method")).toThrow();
    expect(store.database.prepare("SELECT count(*) AS total FROM host_sessions").get()).toEqual({
      total: 3,
    });
  } finally {
    store.close();
  }
});

test("organizer audit accepts the same sign-in methods without accepting anonymous host-key actors", () => {
  const record = (authMethod: string) => ({
    operationId: randomUUID(),
    phase: "request",
    actor: { kind: "organizer", userId: randomUUID(), role: "Admin", authMethod },
    action: "organizer.login",
    resource: { kind: "host" },
    outcome: "succeeded",
  });
  for (const method of ["saml", "local-password"])
    expect(auditRecordSchema.safeParse(record(method)).success).toBe(true);
  for (const method of ["host-key", "unknown-method"])
    expect(auditRecordSchema.safeParse(record(method)).success).toBe(false);
});
