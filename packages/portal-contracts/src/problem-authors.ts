/** Explicit public credits only. These values never identify an authenticated user. */
export interface ProblemAuthor {
  readonly name: string;
  readonly profileUrl?: string;
}

/** Absolute HTTP(S), with no credentials, whitespace or browser URL fixups. */
export function safeAuthorProfileUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/[^/]/u.test(value) || /[\s\\]/u.test(value))
    return undefined;
  const authority = value.split(/[/?#]/u)[2] ?? "";
  if (authority.includes("@") || /(?::\d{6,}|:)$/u.test(authority)) return undefined;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Copy only public fields; malformed links remain plain text credits. */
export function projectProblemAuthors(value: unknown): readonly ProblemAuthor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const authors: ProblemAuthor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim())
      continue;
    const profileUrl = safeAuthorProfileUrl(entry.profileUrl);
    authors.push({ name: entry.name, ...(profileUrl ? { profileUrl } : {}) });
  }
  return authors.length ? authors : undefined;
}

/** Strict authoring validation; runtime display remains defensive for old stores. */
export function isProblemAuthors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).every((key) => key === "name" || key === "profileUrl") &&
        typeof entry.name === "string" &&
        entry.name.trim().length > 0 &&
        (entry.profileUrl === undefined || safeAuthorProfileUrl(entry.profileUrl) !== undefined),
    )
  );
}

/** Omit the field entirely for legacy metadata. */
export function problemAuthorFields(value: unknown): {
  readonly authors?: readonly ProblemAuthor[];
} {
  const authors = projectProblemAuthors(value);
  return authors ? { authors } : {};
}
