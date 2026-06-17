# Expected Risks

This file is the manual test specification for the App-to-Quest sample fixture.
All evidence is local to `fixtures/app-to-quest/sample-vibe-app/`.

## RISK-001: IDOR / Owner Check Missing

- Evidence: `app/api/orders/[id]/route.ts`
- Expected category: `security`, `privacy`
- Expected severity: `critical`
- Expected whatHappensIfIgnored: other users' order details may be exposed.
- Expected success criteria:
  - Own order returns `StatusCodes.OK`.
  - Another user's order returns `StatusCodes.FORBIDDEN` or `StatusCodes.NOT_FOUND`.

## RISK-002: Admin API Server Authorization Missing

- Evidence: `app/admin/page.tsx`, `app/api/admin/users/route.ts`
- Expected category: `security`
- Expected severity: `high`
- Expected whatHappensIfIgnored: non-admin users may list user accounts through
  the API even though the UI hides the action.
- Expected success criteria:
  - Customer role receives `StatusCodes.FORBIDDEN`.
  - Admin role can list users.

## RISK-003: Personal Data Logged

- Evidence: `lib/logger.ts`, `app/api/orders/[id]/route.ts`,
  `app/api/ai/summarize/route.ts`
- Expected category: `privacy`, `operations`
- Expected severity: `high`
- Expected whatHappensIfIgnored: email addresses, shipping addresses, order notes,
  and AI prompts may remain in logs.
- Expected success criteria:
  - Logs use allowlisted fields.
  - Email, address, and prompt bodies are redacted.

## RISK-004: AI Prompt Includes Personal Data

- Evidence: `lib/ai.ts`, `app/api/ai/summarize/route.ts`
- Expected category: `privacy`, `ai-safety`
- Expected severity: `high`
- Expected whatHappensIfIgnored: order details and free-form user notes may be
  shared with an external AI processor without minimization or consent.
- Expected success criteria:
  - Prompt builder excludes direct identifiers and shipping addresses.
  - User-facing policy or consent is documented.

## RISK-005: Paid API Rate Limit Missing

- Evidence: `app/api/ai/summarize/route.ts`, `app/api/checkout/route.ts`
- Expected category: `cost`, `operations`
- Expected severity: `medium`
- Expected whatHappensIfIgnored: repeated requests may drive AI or payment API
  costs and exhaust provider quotas.
- Expected success criteria:
  - Requests are limited by user or IP.
  - Limit failures are logged and return `StatusCodes.TOO_MANY_REQUESTS`.

## RISK-006: Public Secret Name

- Evidence: `.env.example`
- Expected category: `security`
- Expected severity: `medium`
- Expected whatHappensIfIgnored: developers may place an AI provider secret in a
  public client-side environment variable.
- Expected success criteria:
  - Server-only secret names are used.
  - Public variables contain only non-secret values.

## RISK-007: Deletion, backup, and audit gaps

- Evidence: `README.md`, `prisma/schema.prisma`
- Expected category: `reliability`, `privacy`, `operations`
- Expected severity: `medium`
- Expected whatHappensIfIgnored: personal data may be retained after account
  closure, and order data may not be recoverable after an operational incident.
- Expected success criteria:
  - Data deletion or anonymization workflow is defined.
  - backup and restore steps are documented.
  - Admin reads and writes have audit events.
