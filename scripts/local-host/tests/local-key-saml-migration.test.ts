import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueOrganizerSession, randomToken } from "../auth";
import { HostError } from "../model";
import { SamlProtocol } from "../saml-protocol";
import { SamlSignIn } from "../saml-sign-in";
import { HostStore, type OrganizerUser } from "../store";
import { TestSamlIdP } from "./saml-idp-fixture";

let idp: TestSamlIdP;

// Report only a status, even if a regression unexpectedly returns a credential-bearing response.
function rejectedStatus(result: Promise<unknown>): Promise<number> {
  return result.then(
    () => 200,
    (error: unknown) => (error instanceof HostError ? error.status : 500),
  );
}
beforeAll(() => {
  idp = new TestSamlIdP();
});
afterAll(() => idp?.close());

test("key migration rejects issued SAML sessions, verified receipts and an in-flight signed assertion", async () => {
  const store = new HostStore(new Database(":memory:"));
  const signingKey = randomToken();
  const user: OrganizerUser = {
    id: randomUUID(),
    username: "historical-admin",
    role: "Admin",
    status: "active",
    authVersion: 1,
    passwordHash: randomToken(),
    createdAt: Date.now(),
  };
  store.bootstrap(user);
  const saml = new SamlSignIn(store, signingKey, Date.now);
  saml.bindOrigin("http://127.0.0.1:24680");
  saml.configure({
    issuer: idp.issuer,
    entryPoint: "https://idp.example.test/login",
    certificate: idp.certificate,
  });
  saml.link({ userId: user.id, subject: "stable-subject-123" });
  store.setFeatureFlag("saml", true);
  async function signedResponse() {
    const browserProof = randomToken();
    const start = await saml.start({ browserProof });
    const request = idp.request(start.url);
    const response = idp.response({ ...request, assertionId: `_${randomUUID()}` });
    return { browserProof, response, relay: request.relay };
  }
  async function receipt() {
    const signed = await signedResponse();
    return {
      browserProof: signed.browserProof,
      ticket: await saml.consume(signed.response, signed.relay),
    };
  }
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let restore: (() => void) | undefined;
  try {
    const issued = saml.complete(await receipt());
    expect(store.authenticateAdmin(issued.idToken, Date.now()).authMethod).toBe("saml");
    const ready = await receipt();
    const pending = await signedResponse();
    const original = SamlProtocol.prototype.verify;
    const verifier = spyOn(SamlProtocol.prototype, "verify").mockImplementation(async function (
      this: SamlProtocol,
      ...args: Parameters<SamlProtocol["verify"]>
    ) {
      const proof = await original.apply(this, args);
      reached.resolve(undefined);
      await release.promise;
      return proof;
    });
    restore = () => verifier.mockRestore();
    const consuming = saml.consume(pending.response, pending.relay);
    await reached.promise;
    store.ensureLocalOrganizerKey();
    store.rotateLocalOrganizerKey();
    release.resolve(undefined);
    expect(await rejectedStatus(consuming)).toBe(401);
    expect(() => {
      saml.complete(ready);
    }).toThrow();
    expect(() => store.authenticateAdmin(issued.idToken, Date.now())).toThrow();
    const identity = store.identity("saml", idp.issuer, "stable-subject-123");
    if (!identity) throw new Error("Historical SAML mapping was lost.");
    expect(() => {
      issueOrganizerSession(store, signingKey, user, Date.now(), identity);
    }).toThrow();
    expect(saml.available()).toBe(false);
    expect(JSON.stringify(store.organizer(user.id)) === JSON.stringify(user)).toBe(true);
    expect(store.statement("SELECT count(*) AS count FROM host_sessions").get()).toEqual({
      count: 0,
    });
    expect(store.statement("SELECT value FROM host_settings WHERE key='flag:saml'").get()).toEqual({
      value: "true",
    });
  } finally {
    release.resolve(undefined);
    restore?.();
    store.close();
  }
});
