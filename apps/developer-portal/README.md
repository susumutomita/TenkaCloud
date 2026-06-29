# developer-portal

The unified TenkaCloud developer platform (ADR-0003). One Next.js application
serves the landing page, product page, developer hub, MDX docs, the OpenAPI API
reference, examples, and the changelog under a single shared shell.

## Routes

- `/` landing
- `/product`
- `/developers` developer hub
- `/developers/docs/*` MDX docs
- `/developers/api` OpenAPI reference (browse only)
- `/developers/examples`
- `/developers/changelog`

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
interactive sandbox Try-It is deferred to a later PR per ADR-0004.
