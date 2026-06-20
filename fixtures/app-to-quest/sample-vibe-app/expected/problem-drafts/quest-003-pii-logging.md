# Quest: Stop Logging Personal Order Data

## Source App Context

`logDebug()` receives full user, order, and prompt objects from the order and AI
routes.

## Why This Matters

Logs often have broader access and longer retention than application data.

## What Happens If Ignored

Email addresses, shipping addresses, order notes, and AI prompts may remain in
operational logs.

## Mission

Replace raw object logging with log-safe events.

## Initial Broken State

Route handlers pass complete objects to `logDebug()`.

## Target Fixed State

Logs contain only allowlisted fields needed for debugging, such as event name and
non-sensitive request identifiers.

## Success Criteria

- Order lookup logs omit email and shipping address.
- AI summary logs omit prompt bodies.
- Tests capture log payloads and verify redaction.

## Scoring Design

Use local assertions against captured logger calls.

## Safe Simulation Plan

Run tests with the synthetic `.test` users and fixture orders only.

## Hints

- Add a log-safe DTO.
- Prefer explicit allowlists over best-effort redaction.

## Organizer Notes

The learning target is data minimization in observability.

## Safety Notes

Do not copy real logs into the fixture or problem statement.
