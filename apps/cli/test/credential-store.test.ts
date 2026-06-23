import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTokens,
  isExpired,
  loadTokens,
  type StoredTokens,
  saveTokens,
} from "../src/credential-store.ts";

function makeTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: "access-1",
    idToken: "id-1",
    refreshToken: "refresh-1",
    expiresAt: 1000,
    issuer: "https://cognito-idp.local/userpool",
    clientId: "client-1",
    ...overrides,
  };
}

let originalHome: string | undefined;
let tempDir: string;
let credPath: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-credstore-"));
  process.env.HOME = tempDir;
  credPath = join(tempDir, ".config/tenkacloud/credentials");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("saveTokens / loadTokens", () => {
  it("should round-trip stored tokens through the credentials file", () => {
    const tokens = makeTokens();
    saveTokens(tokens);
    expect(loadTokens()).toEqual(tokens);
  });

  it("should create the credentials file with 0600 permissions", () => {
    saveTokens(makeTokens());
    expect(existsSync(credPath)).toBe(true);
    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("should overwrite existing credentials on a subsequent save", () => {
    saveTokens(makeTokens({ accessToken: "first" }));
    saveTokens(makeTokens({ accessToken: "second" }));
    expect(loadTokens()?.accessToken).toBe("second");
  });
});

describe("loadTokens", () => {
  it("should return undefined when no credentials file exists", () => {
    expect(existsSync(credPath)).toBe(false);
    expect(loadTokens()).toBeUndefined();
  });

  it("should return undefined when the credentials file is corrupt JSON", () => {
    // saveTokens first to create the directory, then clobber the file with junk.
    saveTokens(makeTokens());
    writeFileSync(credPath, "{ this is not valid json", { mode: 0o600 });
    expect(loadTokens()).toBeUndefined();
  });

  it("should return undefined when the credentials file was cleared to empty", () => {
    saveTokens(makeTokens());
    clearTokens();
    // Empty string is not valid JSON → the catch branch returns undefined.
    expect(readFileSync(credPath, "utf8")).toBe("");
    expect(loadTokens()).toBeUndefined();
  });
});

describe("clearTokens", () => {
  it("should truncate the credentials file when it exists", () => {
    saveTokens(makeTokens());
    expect(existsSync(credPath)).toBe(true);
    clearTokens();
    // The file is kept but emptied (so a later load returns undefined).
    expect(existsSync(credPath)).toBe(true);
    expect(readFileSync(credPath, "utf8")).toBe("");
  });

  it("should be a no-op when no credentials file exists", () => {
    expect(existsSync(credPath)).toBe(false);
    // Must not throw and must not create a file.
    expect(() => clearTokens()).not.toThrow();
    expect(existsSync(credPath)).toBe(false);
  });
});

describe("isExpired", () => {
  it("should return true when nowSec is at or past expiresAt", () => {
    expect(isExpired(makeTokens({ expiresAt: 1000 }), 1000)).toBe(true);
    expect(isExpired(makeTokens({ expiresAt: 1000 }), 1001)).toBe(true);
  });

  it("should return false when nowSec is before expiresAt", () => {
    expect(isExpired(makeTokens({ expiresAt: 1000 }), 999)).toBe(false);
  });

  it("should default nowSec to the current wall-clock seconds", () => {
    // Far-future expiry is not expired; far-past expiry is expired — using the
    // real Date.now() default (no nowSec argument).
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const past = Math.floor(Date.now() / 1000) - 10_000;
    expect(isExpired(makeTokens({ expiresAt: future }))).toBe(false);
    expect(isExpired(makeTokens({ expiresAt: past }))).toBe(true);
  });
});

describe("credentials path defaults", () => {
  it("should re-chmod an already-existing file back to 0600 on save", () => {
    // First save creates the file; loosen perms, then save again and confirm the
    // explicit chmodSync(path, 0o600) restores them.
    saveTokens(makeTokens());
    chmodSync(credPath, 0o644);
    saveTokens(makeTokens({ accessToken: "again" }));
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
  });
});
