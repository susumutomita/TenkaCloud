# Quest: Rate-Limit Paid Provider Paths

## Source App Context

`app/api/ai/summarize/route.ts` and `app/api/checkout/route.ts` model calls to
paid providers without request throttling.

## Why This Matters

Paid-provider paths need quota controls even when the caller is authenticated.

## What Happens If Ignored

Unexpected request volume may create cost spikes and provider quota exhaustion.

## Mission

Limit repeated AI summary and checkout requests by user or IP.

## Initial Broken State

The routes process every request without a limiter.

## Target Fixed State

The routes reject requests above the quota before provider work is attempted.

## Success Criteria

- Requests inside the quota return success.
- Requests above the quota return `StatusCodes.TOO_MANY_REQUESTS`.
- Limit failures emit a log-safe event.

## Scoring Design

Use local tests with an in-memory limiter and deterministic quotas.

## Safe Simulation Plan

Exercise only local route handlers and provider stubs.

## Hints

- Put the limiter before the provider call.
- Use explicit errors rather than silent fallbacks.

## Organizer Notes

This quest is about cost and operational resilience.

## Safety Notes

Do not connect the fixture to real AI or payment providers.
