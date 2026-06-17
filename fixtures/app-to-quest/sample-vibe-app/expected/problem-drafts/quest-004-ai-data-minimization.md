# Quest: Minimize Data Sent to the AI Summary Path

## Source App Context

`lib/ai.ts` builds a prompt with customer email, name, shipping address, order
note, items, and free-form notes.

## Why This Matters

AI prompts can become external processing events. They should include only data
needed for the task.

## What Happens If Ignored

Customer identity and address data may be shared with an AI processor without
minimization or clear consent.

## Mission

Build a support summary prompt that excludes direct identifiers.

## Initial Broken State

The prompt builder includes direct identifiers and address data.

## Target Fixed State

The prompt contains only task-needed order context, and the route documents the
expected consent or retention policy.

## Success Criteria

- Prompts omit email, customer name, and shipping address.
- Free-form notes are excluded or sanitized.
- A consent or retention policy reference exists.

## Scoring Design

Use prompt snapshot checks and policy-reference checks.

## Safe Simulation Plan

Generate prompts locally without calling an AI provider.

## Hints

- Replace direct identifiers with coarse order context.
- Keep the AI provider adapter easy to review.

## Organizer Notes

This quest focuses on privacy-by-design, not prompt injection.

## Safety Notes

Do not send fixture prompts to a real AI service.
