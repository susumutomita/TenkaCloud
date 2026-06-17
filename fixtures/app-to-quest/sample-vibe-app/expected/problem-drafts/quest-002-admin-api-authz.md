# Quest: Enforce Admin Role on the Users API

## Source App Context

`app/admin/page.tsx` hides admin controls from customers, but
`app/api/admin/users/route.ts` lists users for any authenticated caller.

## Why This Matters

UI checks improve usability, but the API is the security boundary.

## What Happens If Ignored

A non-admin user may enumerate user emails, roles, and last login IPs.

## Mission

Return a forbidden response for non-admin users while preserving admin access.

## Initial Broken State

The API route calls `requireUser()` and `listUsers()` without checking
`user.role`.

## Target Fixed State

The API route checks the authenticated user's role before reading or returning
user records.

## Success Criteria

- Customer role receives `StatusCodes.FORBIDDEN`.
- Admin role receives `StatusCodes.OK`.
- The UI guard remains only a convenience layer.

## Scoring Design

Use a local multi-flag check for customer denial and admin success.

## Safe Simulation Plan

Use the fixture's customer and admin users in local route tests.

## Hints

- Put the role check in the API route.
- Keep the UI branch, but do not depend on it for authorization.

## Organizer Notes

This quest teaches the difference between presentation logic and server
authorization.

## Safety Notes

Do not use real user exports or production admin endpoints.
