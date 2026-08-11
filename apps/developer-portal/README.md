# developer-portal

The unified TenkaCloud developer platform. One Next.js application
serves the landing page, product page, developer hub, MDX docs, the OpenAPI API
reference, examples, and the changelog under a single shared shell.

## Routes

- `/` marketing home (Japanese, primary) · `/en/` (English mirror)
- `/catalog` public problem catalog (Japanese) · `/en/catalog` (English mirror)
- `/product`
- `/developers` developer hub
- `/developers/docs/*` MDX docs
- `/developers/api` OpenAPI reference (browse only)
- `/developers/examples`
- `/developers/changelog`
- `/pitch/` self-contained pitch deck (static asset, unlinked)

The marketing home and catalog render from one bilingual content model
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
bun run --filter @TenkaCloud/developer-portal generate:catalog  # regenerate the catalog data from problems/
bun run --filter @TenkaCloud/developer-portal check:catalog     # fail if catalog data is stale (needs the submodule)
```

## Notes

The build is a static export of the public surface. Broken internal links fail
the build through `scripts/check-internal-links.ts`. The checked-in OpenAPI
artifact defaults to the sandbox base URL and embeds no credentials; the
interactive sandbox Try-It is not part of the current implementation.

The public catalog data (`src/content/catalog-data.ts`) is a **generated,
committed artifact** built from the public `metadata.json` files in the
`problems/` submodule (the single source of truth). Committing it keeps the
static build free of any submodule dependency. After the catalog changes
(including a submodule pin bump), run `generate:catalog` and commit the result;
`check:catalog` verifies it against the submodule but is a maintainer tool, not a
CI gate — the automated pin-bump PR bypasses parent CI, so a hard drift gate would
surprise unrelated PRs.
