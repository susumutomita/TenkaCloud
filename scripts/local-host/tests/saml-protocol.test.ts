import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { join } from "node:path";
import type { CacheProvider } from "@node-saml/node-saml";
import { parseSamlProvider, SamlProtocol } from "../saml-protocol";
import { TestSamlIdP } from "./saml-idp-fixture";

const origin = "http://127.0.0.1:24680";
const issuer = "https://idp.example.test/saml";
const requestId = "_host_request_01234567890123456789";
let idp: TestSamlIdP;
let wrong: TestSamlIdP;
let certificate: string;
let wrongKey: string;
beforeAll(() => {
  idp = new TestSamlIdP();
  wrong = new TestSamlIdP();
  certificate = idp.certificate;
  wrongKey = wrong.privateKey;
});
afterAll(() => {
  idp?.close();
  wrong?.close();
});

function requestCache(database: Database): CacheProvider {
  database.exec("CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return {
    async saveAsync(key, value) {
      database.query("INSERT INTO requests VALUES (?, ?)").run(key, value);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      return (
        database
          .query<{ value: string }, [string]>("SELECT value FROM requests WHERE id=?")
          .get(key)?.value ?? null
      );
    },
    async removeAsync(key) {
      if (key === null) return null;
      const found = database
        .query<{ id: string }, [string]>("DELETE FROM requests WHERE id=? RETURNING id")
        .get(key);
      return found?.id ?? null;
    },
  };
}
function protocol(database: Database) {
  return new SamlProtocol({
    origin,
    requestId,
    cache: requestCache(database),
    provider: parseSamlProvider({
      issuer,
      entryPoint: "https://idp.example.test/login",
      certificate,
    }),
  });
}
function response(changes: Partial<Parameters<TestSamlIdP["response"]>[0]> = {}): string {
  return idp.response({ origin, requestId, ...changes });
}

async function withRequest(check: (saml: SamlProtocol) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  try {
    const saml = protocol(database);
    const redirect = new URL(await saml.authorize("public-relay-state"));
    expect(redirect.origin + redirect.pathname).toBe("https://idp.example.test/login");
    expect(redirect.searchParams.get("RelayState")).toBe("public-relay-state");
    await check(saml);
  } finally {
    database.close();
  }
}

test("verifies real response and assertion signatures and consumes the request", async () => {
  await withRequest(async (saml) => {
    const encoded = response();
    const proof = await saml.verify(encoded, requestId);
    expect(proof).toMatchObject({
      issuer,
      subject: "stable-subject-123",
      assertionId: "_assertion",
      requestId,
    });
    expect(proof.expiresAt).toBeGreaterThan(Date.now());
    await expect(saml.verify(encoded, requestId)).rejects.toMatchObject({
      status: 401,
      kind: "invalid_saml_response",
    });
  });
});

test("pending request correlation survives reopening SQLite", async () => {
  const path = join(idp.directory, "durable.sqlite");
  const first = new Database(path);
  await protocol(first).authorize("relay");
  first.close();
  const reopened = new Database(path);
  try {
    expect((await protocol(reopened).verify(response(), requestId)).subject).toBe(
      "stable-subject-123",
    );
  } finally {
    reopened.close();
  }
});

for (const [label, changes] of [
  ["issuer", { issuer: "https://other-idp.example.test" }],
  ["destination", { destination: "https://evil.example.test/acs" }],
  ["recipient", { recipient: "https://evil.example.test/acs" }],
  ["audience", { audience: "https://other-host.example.test" }],
  ["correlation", { requestId: "_attacker_request" }],
  ["transient identity", { format: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }],
  ["expired assertion", { expires: "2000-01-01T00:00:00.000Z" }],
  ["error status", { status: "Responder" }],
] as const) {
  test(`rejects signed response with wrong ${label}`, async () => {
    await withRequest(async (saml) => {
      await expect(saml.verify(response(changes), requestId)).rejects.toMatchObject({
        status: 401,
        kind: "invalid_saml_response",
      });
    });
  });
}

test("rejects a different signing key and altered signed content without leaking XML", async () => {
  for (const payload of [
    response({ key: wrongKey }),
    Buffer.from(
      Buffer.from(response(), "base64")
        .toString()
        .replace("stable-subject-123", "LEAKED_ASSERTION_SECRET"),
    ).toString("base64"),
  ]) {
    await withRequest(async (saml) => {
      try {
        await saml.verify(payload, requestId);
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).toMatchObject({
          status: 401,
          message: "SAML sign-in could not be verified. Start sign-in again.",
        });
      }
    });
  }
});

test("rejects malformed XML, entities and missing signatures", async () => {
  for (const xml of [
    "<",
    "<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///etc/passwd'>]><x>&y;</x>",
    "<Response/>",
  ]) {
    await withRequest(async (saml) => {
      await expect(
        saml.verify(Buffer.from(xml).toString("base64"), requestId),
      ).rejects.toMatchObject({ status: 401 });
    });
  }
});

test("provider setup rejects remote HTTP, credentials in URLs and non-certificates", () => {
  for (const bad of [
    { entryPoint: "http://idp.example.test/login" },
    { entryPoint: "https://user:pass@idp.example.test/login" },
    { certificate: "not a certificate" },
  ]) {
    expect(() =>
      parseSamlProvider({
        issuer,
        entryPoint: "https://idp.example.test/login",
        certificate,
        ...bad,
      }),
    ).toThrow();
  }
});
