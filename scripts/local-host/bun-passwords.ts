import type { OrganizerPasswords } from "./organizer-passwords";

/** Keep Bun's existing Argon2id algorithm, default parameters and encoded hash unchanged. */
export const bunOrganizerPasswords: OrganizerPasswords = {
  hash: (value) => Bun.password.hash(value, { algorithm: "argon2id" }),
  verify: (value, hash) => Bun.password.verify(value, hash),
};
