import { afterEach, expect, it, vi } from "vitest";
import {
  clearLocalHostSession,
  loadLocalHostSession,
  saveLocalHostSession,
} from "../../src/auth/local-host-session";

const key = "TenkaCloud.localHost.organizerSession";
const tokens = { idToken: "a.e30.c", accessToken: "a.e30.c", refreshToken: "r", expiresAt: 2_000 };

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it("restores an unexpired session saved in this tab and forgets it on clear", () => {
  saveLocalHostSession(tokens);
  expect(loadLocalHostSession(1_000)).toEqual(tokens);
  clearLocalHostSession();
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(loadLocalHostSession(1_000)).toBeNull();
});

it.each([
  ["expired", JSON.stringify(tokens), 2_000],
  ["malformed", "{", 1_000],
  ["incomplete", JSON.stringify({ ...tokens, refreshToken: undefined }), 1_000],
])("drops an %s copy instead of signing in with it", (_label, raw, now) => {
  sessionStorage.setItem(key, raw);
  expect(loadLocalHostSession(now)).toBeNull();
  expect(sessionStorage.getItem(key)).toBeNull();
});

it("keeps working when the browser refuses storage", () => {
  const refusing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  expect(() => saveLocalHostSession(tokens, refusing)).not.toThrow();
  expect(() => clearLocalHostSession(refusing)).not.toThrow();
  expect(loadLocalHostSession(1_000, refusing)).toBeNull();
});

it("keeps working when merely reading sessionStorage throws", () => {
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(() => saveLocalHostSession(tokens)).not.toThrow();
  expect(() => clearLocalHostSession()).not.toThrow();
  expect(loadLocalHostSession(1_000)).toBeNull();
});
