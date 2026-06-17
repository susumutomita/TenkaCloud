# Quest: Define deletion, backup, restore, and audit behavior

## Source App Context

`prisma/schema.prisma` stores user and order data, while the fixture README does
not define lifecycle or recovery behavior.

## Why This Matters

Personal data needs lifecycle controls, and operational data needs tested
recovery paths.

## What Happens If Ignored

Personal data may remain after account closure, and order history may be
unrecoverable after data loss.

## Mission

Write a reviewable deletion, backup, restore, and audit plan.

## Initial Broken State

The schema has no associated deletion, retention, backup, restore, or audit
behavior.

## Target Fixed State

The app defines how data is deleted or anonymized, how backups are verified, and
how admin access is audited.

## Success Criteria

- A user deletion or anonymization flow is documented.
- backup and restore verification steps are documented.
- Admin access creates audit events.

## Scoring Design

Use static checks for the required plan sections and local audit hook tests.

## Safe Simulation Plan

Produce documentation and local test hooks without connecting to production
services.

## Hints

- Tie lifecycle rules to each personal field.
- Do not assume backups work until restore has been tested.

## Organizer Notes

This quest is appropriate for operations-focused learners.

## Safety Notes

Do not export real database backups for the exercise.
