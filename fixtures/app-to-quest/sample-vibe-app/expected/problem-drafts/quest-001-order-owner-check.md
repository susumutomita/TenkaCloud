# Quest: Protect Order Details With Owner Checks

## Source App Context

`app/api/orders/[id]/route.ts` authenticates the caller and then returns the
requested order by ID.

## Why This Matters

Order records include items, notes, and shipping addresses. Authentication alone
does not prove the caller owns the requested order.

## What Happens If Ignored

A customer may view another customer's order details and shipping address.

## Mission

Make order lookup enforce per-user ownership.

## Initial Broken State

The route calls `findOrderById(id)` and returns the result without comparing
`order.userId` to `user.id`.

## Target Fixed State

The route returns an order only when it belongs to the authenticated user.

## Success Criteria

- Own order returns `StatusCodes.OK`.
- Another user's order returns `StatusCodes.FORBIDDEN` or `StatusCodes.NOT_FOUND`.
- Missing orders still return `StatusCodes.NOT_FOUND`.

## Scoring Design

Use a local multi-flag check for own-order success, cross-owner denial, and
missing-order behavior.

## Safe Simulation Plan

Use only the seeded fixture orders owned by `user_001` and `user_002`.

## Hints

- Check ownership before returning the order body.
- Avoid leaking whether another user's order exists.

## Organizer Notes

This quest is a server-side authorization exercise, not a production scan.

## Safety Notes

Do not test against real customer data or real order IDs.
