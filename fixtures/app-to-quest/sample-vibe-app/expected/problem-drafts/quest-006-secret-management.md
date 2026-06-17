# Quest: Keep Provider Secrets Out of Public Config

## Source App Context

`.env.example` contains `NEXT_PUBLIC_OPENAI_API_KEY=` as an empty placeholder.

## Why This Matters

Variables with `NEXT_PUBLIC_` are intended for browser-visible configuration in
Next.js-style apps.

## What Happens If Ignored

A real provider API key may be bundled into client-side code and abused by anyone
who can load the app.

## Mission

Rename provider secrets as server-only values and document public config rules.

## Initial Broken State

The example uses a public prefix for a secret-like AI provider key.

## Target Fixed State

Secret-like values use server-only names, and public variables are limited to
non-secret values.

## Success Criteria

- No secret-like key uses a `NEXT_PUBLIC_` prefix.
- Example values are empty or obvious placeholders.
- Documentation explains which variables are browser-visible.

## Scoring Design

Use a static scan of `.env.example` and a documentation assertion.

## Safe Simulation Plan

Scan only fixture files.

## Hints

- Use names such as `OPENAI_API_KEY` only on the server.
- Keep client-side config limited to non-secret identifiers.

## Organizer Notes

This quest teaches framework-specific secret handling.

## Safety Notes

Do not include real API keys in examples or tests.
