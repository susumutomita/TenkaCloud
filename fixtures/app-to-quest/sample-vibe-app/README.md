# Sample Vibe App Fixture

This fixture is a small, synthetic order-management app for App-to-Quest testing.
It is intentionally incomplete and intentionally risky so CodeWiki-style analysis
can produce a source app profile, a risk inventory, quest candidates, and problem
drafts.

The fixture is not a production app and must not be deployed. It has no real
customer data, no real secret values, and no live external service integration.

## App Shape

- Customers can view recent orders.
- A client-side admin page hides user-management controls from non-admin users.
- API routes expose order lookup, admin user listing, AI order summarization, and
  checkout creation.
- The database layer is an in-memory seed with `.test` addresses and sample names.
- The AI and payment calls are local stubs that model data flow without making
  network requests.

## Intentional Risks

- `app/api/orders/[id]/route.ts` authenticates a user but does not check
  `order.userId === user.id`.
- `app/api/admin/users/route.ts` authenticates a user but does not enforce the
  admin role on the server.
- `lib/logger.ts` writes full user, order, and prompt objects to logs.
- `lib/ai.ts` builds a prompt from email, shipping address, order items, and
  free-form notes.
- `app/api/ai/summarize/route.ts` and `app/api/checkout/route.ts` have no
  per-user or per-IP rate limit.
- `.env.example` includes a deliberately unsafe public API key name with an empty
  placeholder value.
- `prisma/schema.prisma` stores personal data but does not define deletion,
  retention, audit, backup, or restore behavior.

## Expected Outputs

Golden outputs live under `expected/`:

- `01-source-app-profile.json`
- `02-risk-inventory.md`
- `03-quest-candidates.json`
- `problem-drafts/*.md`

These files are the manual verification target for the App-to-Quest mode tracked
by issue `#1824`.
