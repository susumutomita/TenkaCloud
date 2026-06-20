# Risk Inventory

## RISK-001: IDOR / Owner Check Missing

- Category: `security`, `privacy`
- Severity: `critical`
- Evidence: `app/api/orders/[id]/route.ts`
- Risk statement: the route authenticates a user but returns an order by ID
  without confirming the order belongs to that user.
- What happens if ignored: customers may see another customer's order items,
  notes, and shipping address.
- Affected users/data: customer order records and shipping addresses.
- Likelihood: `high`
- Impact: `high`
- Confidence: `high`
- Safe simulation idea: use seeded fixture orders owned by different demo users
  and assert cross-owner access is rejected after remediation.

## RISK-002: Admin API Server Authorization Missing

- Category: `security`
- Severity: `high`
- Evidence: `app/admin/page.tsx`, `app/api/admin/users/route.ts`
- Risk statement: the admin page hides controls for non-admin users, but the API
  route lists users for any authenticated user.
- What happens if ignored: a non-admin customer may enumerate user accounts and
  related metadata through the API.
- Affected users/data: user emails, names, roles, and last login IPs.
- Likelihood: `medium`
- Impact: `high`
- Confidence: `high`
- Safe simulation idea: call the API as a customer fixture user and assert a
  forbidden response after remediation.

## RISK-003: Personal Data Logged

- Category: `privacy`, `operations`
- Severity: `high`
- Evidence: `lib/logger.ts`, `app/api/orders/[id]/route.ts`,
  `app/api/ai/summarize/route.ts`
- Risk statement: full user, order, and prompt objects are passed to logging.
- What happens if ignored: support logs may retain email addresses, shipping
  addresses, free-form notes, and AI prompts longer than intended.
- Affected users/data: all customers whose orders or AI summaries are requested.
- Likelihood: `high`
- Impact: `medium`
- Confidence: `high`
- Safe simulation idea: inspect captured log payloads and verify only allowlisted
  non-personal fields remain after remediation.

## RISK-004: AI Prompt Includes Personal Data

- Category: `privacy`, `ai-safety`
- Severity: `high`
- Evidence: `lib/ai.ts`, `app/api/ai/summarize/route.ts`
- Risk statement: the prompt builder includes direct identifiers and addresses
  before invoking the AI summary path.
- What happens if ignored: personal order context may be sent to an external AI
  processor without minimization, notice, or review.
- Affected users/data: customer email, name, address, order note, and free-form
  notes.
- Likelihood: `medium`
- Impact: `high`
- Confidence: `high`
- Safe simulation idea: snapshot the generated prompt and require redaction of
  direct identifiers.

## RISK-005: Paid API Rate Limit Missing

- Category: `cost`, `operations`
- Severity: `medium`
- Evidence: `app/api/ai/summarize/route.ts`, `app/api/checkout/route.ts`
- Risk statement: paid-provider-like paths do not enforce per-user or per-IP
  request limits.
- What happens if ignored: accidental loops or abusive clients may create
  unexpected provider costs and quota exhaustion.
- Affected users/data: platform operators and legitimate customers during quota
  exhaustion.
- Likelihood: `medium`
- Impact: `medium`
- Confidence: `medium`
- Safe simulation idea: use a local in-memory limiter test double and assert a
  too-many-requests response after the quota is exceeded.

## RISK-006: Public Secret Name

- Category: `security`
- Severity: `medium`
- Evidence: `.env.example`
- Risk statement: a public client-side environment variable name suggests an AI
  provider secret may be placed in browser-visible config.
- What happens if ignored: developers may accidentally expose a provider API key
  to the client bundle.
- Affected users/data: operator API keys and provider account quota.
- Likelihood: `medium`
- Impact: `medium`
- Confidence: `high`
- Safe simulation idea: update the example to use server-only names and add a
  documentation check for public secret-like keys.

## RISK-007: Deletion, backup, and audit gaps

- Category: `reliability`, `privacy`, `operations`
- Severity: `medium`
- Evidence: `README.md`, `prisma/schema.prisma`
- Risk statement: the schema stores personal data, but no deletion, retention,
  backup, restore, or audit behavior is defined.
- What happens if ignored: personal data may remain after account closure, and
  order data may not be recoverable after data loss or migration failure.
- Affected users/data: all customer profiles and orders.
- Likelihood: `medium`
- Impact: `medium`
- Confidence: `medium`
- Safe simulation idea: write a remediation plan that defines deletion,
  anonymization, restore verification, and admin audit events.
