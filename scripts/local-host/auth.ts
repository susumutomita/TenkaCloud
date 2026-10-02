import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { digest, type HostStore, type OrganizerIdentity, type OrganizerUser } from "./store";
export const randomToken = (): string => randomBytes(32).toString("base64url");
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Existing event routes use ULID wire identifiers. */
export function id(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError("Identifier timestamp must be a nonnegative 48-bit integer.");
  }
  let value = BigInt(now);
  for (const byte of randomBytes(10)) value = (value << 8n) | BigInt(byte);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}

export function issueOrganizerSession(
  store: HostStore,
  masterKey: string,
  user: OrganizerUser,
  now: number,
  identity: OrganizerIdentity,
) {
  return createSession(store, masterKey, now, user, identity);
}

export function issueLocalOrganizerSession(
  store: HostStore,
  masterKey: string,
  now: number,
  keyVersion: number,
) {
  return createSession(store, masterKey, now, undefined, undefined, keyVersion);
}

function createSession(
  store: HostStore,
  masterKey: string,
  now: number,
  user?: OrganizerUser,
  identity?: OrganizerIdentity,
  keyVersion?: number,
) {
  const expiresAt = now + 8 * 60 * 60 * 1000;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: user?.id ?? "local-host",
    jti: randomToken(),
    iss: "tenkacloud-local-host",
    aud: "host-console",
    "custom:userRole": user?.role === "Viewer" ? "TenantViewer" : "TenantAdmin",
    "custom:organizerRole": user?.role ?? "Admin",
    ...(user ? { email: user.username } : {}),
    "custom:tenantId": "local-host",
    "custom:tenantName": "Local competition",
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt / 1000),
  })}`;
  const idToken = `${payload}.${createHmac("sha256", masterKey).update(payload).digest("base64url")}`;
  const refreshToken = randomToken();
  // Exact issued-token membership is the authority; accepting arbitrary client JWT claims is not.
  store.addSession(idToken, refreshToken, expiresAt, now, user, identity, keyVersion);
  return {
    idToken,
    accessToken: idToken,
    refreshToken,
    expiresAt,
  };
}
/** Per-key queue protects read/verify/write across asynchronous external verifiers. */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
