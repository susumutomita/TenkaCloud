/**
 * `js-yaml@3.15.0` (pinned in `package.json`, already resolved in `bun.lock` as a transitive
 * dependency of `gray-matter` / `prh` via `overrides`) ships no bundled TypeScript types, and
 * `@types/js-yaml` is not a repository dependency. This narrows the ambient surface to exactly
 * what `compose-policy.ts` uses — the *safe* loader only, which never instantiates arbitrary JS
 * types from the document (important: the input here is catalog Compose YAML, `untrusted input`
 * per the compose trust table).
 */
declare module "js-yaml" {
  export function safeLoad(input: string): unknown;
}
