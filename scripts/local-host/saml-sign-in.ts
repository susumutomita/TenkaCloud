import { randomUUID } from "node:crypto";
import type { CacheProvider } from "@node-saml/node-saml";
import { z } from "zod";
import { issueOrganizerSession, randomToken } from "./auth";
import { HostError } from "./model";
import {
  parseSamlProvider,
  SAML_REQUEST_TTL,
  SamlProtocol,
  type SamlProvider,
} from "./saml-protocol";
import { digest, type HostStore, type OrganizerIdentity } from "./store";

const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const completeSchema = z.object({ ticket: proofSchema, browserProof: proofSchema }).strict();
const mappingSchema = z
  .object({ userId: z.string().min(1).max(64), subject: z.string().trim().min(1).max(1024) })
  .strict();
interface Configuration {
  revision: string;
  body: string | null;
}
interface Pending {
  requestId: string;
  browserHash: string;
  revision: string;
  expires: number;
}
interface Receipt {
  userId: string;
  identityId: string;
  authVersion: number;
  browserHash: string;
  revision: string;
  expires: number;
}
function denied(): never {
  throw new HostError(
    401,
    "SAML sign-in could not be verified. Start sign-in again.",
    "invalid_saml_response",
  );
}

export class SamlSignIn {
  private origin: string | undefined;
  constructor(
    private readonly store: HostStore,
    private readonly masterKey: string,
    private readonly now: () => number,
  ) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS host_saml_config(id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, body TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS host_saml_pending(
        request_id TEXT PRIMARY KEY, relay_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
        revision TEXT NOT NULL, expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_saml_request_cache(
        request_id TEXT PRIMARY KEY REFERENCES host_saml_pending(request_id) ON DELETE CASCADE,
        value TEXT NOT NULL, expires INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_saml_assertions(key TEXT PRIMARY KEY, expires INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS host_saml_receipts(
        ticket_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES host_organizer_users(id) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES host_organizer_identities(id) ON DELETE CASCADE,
        auth_version INTEGER NOT NULL, browser_hash TEXT NOT NULL, revision TEXT NOT NULL, expires INTEGER NOT NULL
      ) STRICT;
    `);
    store.statement("INSERT OR IGNORE INTO host_saml_config VALUES (1,?,NULL)").run(randomToken());
  }
  bindOrigin(origin: string): void {
    if (this.origin && this.origin !== origin)
      throw new Error("SAML host origin is already bound.");
    this.origin = origin;
  }
  private configuration(): Configuration {
    return this.store
      .statement("SELECT revision,body FROM host_saml_config WHERE id=1")
      .get() as Configuration;
  }
  private enabled(): { revision: string; provider: SamlProvider } {
    const configuration = this.configuration();
    if (!this.store.bootstrapCompleted() || !this.store.featureFlags().saml || !configuration.body)
      throw new HostError(404, "SAML sign-in is unavailable.", "saml_disabled");
    return {
      revision: configuration.revision,
      provider: parseSamlProvider(JSON.parse(configuration.body)),
    };
  }
  available(): boolean {
    return (
      this.store.bootstrapCompleted() &&
      this.store.featureFlags().saml === true &&
      this.configuration().body !== null
    );
  }
  settings() {
    const body = this.configuration().body;
    return {
      provider: body ? parseSamlProvider(JSON.parse(body)) : null,
      enabled: this.available(),
      entityId: `${this.origin}/api/host/saml/metadata`,
      callbackUrl: `${this.origin}/api/host/saml/acs`,
      identities: this.identities(),
    };
  }
  configure(raw: unknown): void {
    const provider = parseSamlProvider(raw);
    this.store.transaction(() => {
      this.invalidate();
      this.store
        .statement("UPDATE host_saml_config SET body=? WHERE id=1")
        .run(JSON.stringify(provider));
    });
  }
  // The caller includes this in the flag-change transaction so re-enabling cannot revive a login.
  invalidate(): void {
    this.store.statement("UPDATE host_saml_config SET revision=? WHERE id=1").run(randomToken());
    this.store.database.exec(
      "DELETE FROM host_saml_pending; DELETE FROM host_saml_receipts; DELETE FROM host_sessions WHERE auth_method='saml';",
    );
  }
  identities(): OrganizerIdentity[] {
    return this.store
      .statement(
        "SELECT id,provider,issuer,subject,user_id AS userId FROM host_organizer_identities WHERE provider='saml' ORDER BY issuer,subject",
      )
      .all() as OrganizerIdentity[];
  }
  link(raw: unknown): string {
    const parsed = mappingSchema.safeParse(raw);
    if (!parsed.success)
      throw new HostError(400, "Choose an existing organizer and a persistent NameID.");
    const body = this.configuration().body;
    if (!body) throw new HostError(409, "Configure the identity provider first.");
    const provider = parseSamlProvider(JSON.parse(body));
    const user = this.store.organizer(parsed.data.userId);
    if (!user) throw new HostError(404, "Organizer not found.");
    if (
      this.identities().some(
        (identity) =>
          identity.issuer === provider.issuer &&
          (identity.subject === parsed.data.subject || identity.userId === user.id),
      )
    )
      throw new HostError(409, "This organizer or NameID is already linked to this provider.");
    const identityId = randomUUID();
    this.store
      .statement(
        "INSERT INTO host_organizer_identities(id,provider,issuer,subject,user_id) VALUES (?,'saml',?,?,?)",
      )
      .run(identityId, provider.issuer, parsed.data.subject, user.id);
    return identityId;
  }
  unlink(identityId: string): void {
    this.store
      .statement("DELETE FROM host_organizer_identities WHERE id=? AND provider='saml'")
      .run(identityId);
  }
  private cache(): CacheProvider {
    const store = this.store;
    return {
      saveAsync: async (key, value) => {
        const createdAt = this.now();
        store
          .statement("INSERT INTO host_saml_request_cache VALUES (?,?,?)")
          .run(key, value, createdAt + SAML_REQUEST_TTL);
        return { value, createdAt };
      },
      getAsync: async (key) => {
        const row = store
          .statement("SELECT value FROM host_saml_request_cache WHERE request_id=? AND expires>?")
          .get(key, this.now()) as { value: string } | undefined;
        return row?.value ?? null;
      },
      removeAsync: async (key) => {
        if (key === null) return null;
        const row = store
          .statement(
            "DELETE FROM host_saml_request_cache WHERE request_id=? RETURNING request_id AS id",
          )
          .get(key) as { id: string } | undefined;
        return row?.id ?? null;
      },
    };
  }
  private protocol(provider: SamlProvider, requestId?: string): SamlProtocol {
    if (!this.origin) throw new Error("SAML host origin is not bound.");
    return new SamlProtocol({ provider, origin: this.origin, cache: this.cache(), requestId });
  }
  metadata(): string {
    return this.protocol(this.enabled().provider).metadata();
  }
  async start(raw: unknown): Promise<{ url: string }> {
    const parsed = z.object({ browserProof: proofSchema }).strict().safeParse(raw);
    if (!parsed.success) throw new HostError(400, "Provide a browser sign-in proof.");
    const { revision, provider } = this.enabled();
    const requestId = `_${randomToken()}`;
    const relayState = randomToken();
    const now = this.now();
    this.store.statement("DELETE FROM host_saml_pending WHERE expires<=?").run(now);
    this.store.statement("DELETE FROM host_saml_receipts WHERE expires<=?").run(now);
    this.store.statement("DELETE FROM host_saml_assertions WHERE expires<=?").run(now);
    const count = this.store.statement("SELECT count(*) AS count FROM host_saml_pending").get() as {
      count: number;
    };
    if (count.count >= 1000)
      throw new HostError(429, "Too many pending sign-ins. Retry in five minutes.");
    this.store
      .statement(
        "INSERT INTO host_saml_pending(request_id,relay_hash,browser_hash,revision,expires) VALUES (?,?,?,?,?)",
      )
      .run(
        requestId,
        digest(relayState),
        digest(parsed.data.browserProof),
        revision,
        now + SAML_REQUEST_TTL,
      );
    try {
      const url = await this.protocol(provider, requestId).authorize(relayState);
      if (this.enabled().revision !== revision) denied();
      return { url };
    } catch {
      this.store.statement("DELETE FROM host_saml_pending WHERE request_id=?").run(requestId);
      denied();
    }
  }
  async consume(response: string, relayState: string): Promise<string> {
    if (!proofSchema.safeParse(relayState).success) denied();
    const { revision, provider } = this.enabled();
    const pending = this.store
      .statement(`UPDATE host_saml_pending SET claimed=1
      WHERE relay_hash=? AND claimed=0 AND expires>? AND revision=?
      RETURNING request_id AS requestId,browser_hash AS browserHash,revision,expires`)
      .get(digest(relayState), this.now(), revision) as Pending | undefined;
    if (!pending) denied();
    try {
      const proof = await this.protocol(provider).verify(response, pending.requestId, this.now());
      return this.store.transaction(() => {
        if (this.enabled().revision !== revision || pending.expires <= this.now()) denied();
        const identity = this.store.identity("saml", proof.issuer, proof.subject);
        const user = identity ? this.store.organizer(identity.userId) : undefined;
        if (!identity || !user || user.status !== "active") denied();
        const assertionKey = digest(JSON.stringify([proof.issuer, proof.assertionId]));
        const existing = this.store
          .statement("SELECT key FROM host_saml_assertions WHERE key=?")
          .get(assertionKey);
        if (existing) denied();
        this.store
          .statement("INSERT INTO host_saml_assertions VALUES (?,?)")
          .run(assertionKey, proof.expiresAt + SAML_REQUEST_TTL);
        const ticket = randomToken();
        this.store
          .statement("INSERT INTO host_saml_receipts VALUES (?,?,?,?,?,?,?)")
          .run(
            digest(ticket),
            user.id,
            identity.id,
            user.authVersion,
            pending.browserHash,
            revision,
            Math.min(proof.expiresAt, this.now() + 60_000),
          );
        return ticket;
      });
    } catch {
      denied();
    } finally {
      this.store
        .statement("DELETE FROM host_saml_pending WHERE request_id=?")
        .run(pending.requestId);
    }
  }
  complete(raw: unknown) {
    const parsed = completeSchema.safeParse(raw);
    if (!parsed.success) denied();
    return this.store.transaction(() => {
      const { revision, provider } = this.enabled();
      const receipt = this.store
        .statement(`SELECT user_id AS userId,identity_id AS identityId,
        auth_version AS authVersion,browser_hash AS browserHash,revision,expires FROM host_saml_receipts WHERE ticket_hash=?`)
        .get(digest(parsed.data.ticket)) as Receipt | undefined;
      if (
        !receipt ||
        receipt.expires <= this.now() ||
        receipt.revision !== revision ||
        receipt.browserHash !== digest(parsed.data.browserProof)
      )
        denied();
      const identity = this.identities().find(
        (candidate) => candidate.id === receipt.identityId && candidate.issuer === provider.issuer,
      );
      const user = this.store.organizer(receipt.userId);
      if (
        !identity ||
        identity.userId !== receipt.userId ||
        !user ||
        user.status !== "active" ||
        user.authVersion !== receipt.authVersion
      )
        denied();
      this.store
        .statement("DELETE FROM host_saml_receipts WHERE ticket_hash=?")
        .run(digest(parsed.data.ticket));
      return issueOrganizerSession(this.store, this.masterKey, user, this.now(), identity);
    });
  }
}
