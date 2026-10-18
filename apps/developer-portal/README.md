# developer-portal

A separate Next.js developer portal export containing the landing page, product page, developer hub, MDX docs, the OpenAPI API
reference, examples, and the changelog under a single shared shell.

## Routes

- `/` marketing home (Japanese, primary) · `/en/` (English mirror)
- `/product`
- `/developers` developer hub
- `/developers/docs/*` MDX docs
- `/developers/api` OpenAPI reference (browse only)
- `/developers/examples`
- `/developers/changelog`
- `/pitch/` self-contained pitch deck (static asset, unlinked)

The marketing home renders from one bilingual content model
(`src/content/site-copy.ts`), so the JA and EN versions stay structurally
identical (ja + en only). New public routes must be registered in
`src/lib/routes.ts` (the build-time link checker fails on any unregistered
internal link).

## Commands

```bash
bun run --filter @TenkaCloud/developer-portal dev          # dev server on :5176
bun run --filter @TenkaCloud/developer-portal build        # static export (runs the link check first)
bun run --filter @TenkaCloud/developer-portal test         # vitest
bun run --filter @TenkaCloud/developer-portal check:links  # build-time internal link checker
```

## Notes

The build is a static export of the public surface. Broken internal links fail
the build through `scripts/check-internal-links.ts`. The checked-in OpenAPI
artifact defaults to the sandbox base URL and embeds no credentials; the
interactive sandbox Try-It is not part of the current implementation.

The published site is `landing/` (see the root `wrangler.toml`). Its browser
onboarding demo is built from `apps/participant-portal`; this Next.js export
is separate. Public problem browsing links to TenkaCloudChallenge. Runtime
catalogs read the organizer-selected problem metadata and immutable snapshots.
