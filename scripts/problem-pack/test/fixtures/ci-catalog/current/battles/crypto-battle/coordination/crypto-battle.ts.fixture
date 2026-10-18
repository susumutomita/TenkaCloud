/**
 * Coordination plugin wiring for the PROVE / LEAK / HUNT / ROTATE Battle
 * (Issue #486, PR3).
 *
 * This is a THIN WRAPPER, not a reimplementation: `../game/src/reducer.ts`'s
 * `initialState` / `validateOp` / `applyOp` / `tick` / `projectForTeam` were
 * already written (PR1/PR2) with the exact shape a
 * `@tenkacloud/coordination-plugin-sdk` `CoordinationPlugin<State, Op,
 * Projection>` needs -- see that file's header. Nothing about the game
 * (Shamir sharing, sudoku PROVE, contract issuance, scoring) is duplicated
 * or re-derived here; this file only forwards those five exports through
 * `defineCoordinationPlugin`.
 *
 * ## Why a thin wrapper (relative import), not vendoring -- investigated in
 * the (read-only) TenkaCloud checkout
 *
 * `battles/microservice-migration-battle/coordination/router.ts` and
 * TenkaCloud's own reference plugin
 * (`packs/reference-coordination-battle/.../coordination/sector-control.ts`)
 * are both self-contained single files, but neither had a sibling game
 * package to reuse -- they are not evidence that a plugin *must* avoid
 * relative imports outside `coordination/`. The actual load path,
 * `TenkaCloud/infrastructure/lib/utils/bundle-coordination-plugins.ts:19-45`
 * (`bundleCoordinationPlugins`), esbuild-`buildSync`s each declared plugin
 * with `{ bundle: true, format: "esm", platform: "node" }`, entry =
 * `<problems-root>/<problem-dir>/<interTeamCoordination.plugin>`. `bundle:
 * true` makes esbuild resolve and INLINE every relative import the entry
 * file makes, however deep the chain -- verified locally by pointing the
 * same esbuild config at this file's whole `game/src` import graph
 * (`reducer.ts` -> `fixtures.ts` / `field.ts` / `sudoku.ts` /
 * `decimal.ts` -> `prng.ts` / ...): it bundled cleanly into one ~21.6 KB ESM
 * file with no resolution errors. So importing `../game/src/reducer.ts`
 * directly here -- rather than hand-copying its logic into this file -- is
 * exactly what the loader expects, and is what this repo's PR1/PR2 header
 * comments in `reducer.ts` / `types.ts` already anticipated ("PR3 wires
 * these exports into a thin plugin file, without reshaping them").
 *
 * The bare `@tenkacloud/coordination-plugin-sdk` import resolves for the
 * same reason `router.ts`'s already does: `problems/` is a git submodule
 * *inside* the TenkaCloud checkout
 * (`TenkaCloud/.gitmodules`: `submodule "problems"` ->
 * `TenkaCloudChallenge.git`), and `problemsRoot` at synth time is
 * `path.resolve(binDir, "..", "..", "problems")`
 * (`TenkaCloud/infrastructure/lib/app-config/resolve.ts:336`) -- i.e. this
 * file's real on-disk path when esbuild runs is
 * `TenkaCloud/problems/battles/crypto-battle/coordination/crypto-battle.ts`.
 * esbuild's bare-specifier resolution walks up parent directories'
 * `node_modules` from there, past the submodule boundary (a filesystem walk
 * does not stop at a `.git` boundary), and finds
 * `TenkaCloud/node_modules/@tenkacloud/coordination-plugin-sdk` -- a bun/npm
 * workspace symlink to `TenkaCloud/packages/coordination-plugin-sdk`
 * (`TenkaCloud/package.json`'s `workspaces: ["infrastructure", "apps/*",
 * "packages/*"]`).
 *
 * `platform: "node"` leaves Node built-ins external instead of bundling (or
 * failing to resolve) them -- confirmed locally: bundling a probe file that
 * imports `node:crypto`'s `createHash` under the identical `buildSync`
 * config keeps `import { createHash } from "node:crypto"` in the output
 * rather than inlining or erroring. That matters here because
 * `game/src/prng.ts` (SHA-256 seed derivation, used by every "randomness" in
 * this package -- secrets, Shamir coefficients, the contract schedule) and
 * `game/src/fixtures.ts` (relabelling tags) both import
 * `createHash` from `node:crypto`. The bundled `.mjs` this produces is later
 * `import()`-ed by
 * `TenkaCloud/infrastructure/lib/problem-deploy/handlers/coordination-dispatcher-handler/index.ts`
 * (a `hono/aws-lambda` Hono app, imported there at line 3) running on a
 * Node.js AWS Lambda runtime, and
 * `.../coordination-dispatcher-handler/s3-plugin-importer.ts` itself imports
 * `createHash` / `timingSafeEqual` from `node:crypto` at its own top (line
 * 1) to verify the downloaded bundle's digest before `import()`-ing it --
 * i.e. the dispatcher's own trusted-side code already depends on
 * `node:crypto` being available in that Lambda, so this plugin doing the
 * same needs no special-casing and no pure-JS SHA-256 vendoring.
 *
 * `coordination-plugin-loader.ts`'s `isCoordinationPlugin` (participant
 * handler) only checks that the default export structurally has
 * `initialState` / `validateOp` / `applyOp` / `projectForTeam` functions
 * (`tick` optional) -- exactly the five hooks forwarded below.
 *
 * ## Seed
 *
 * `initialState`'s seed is `ctx.eventId` -- reducer.ts's `initialState`
 * already sets `seed: ctx.eventId` directly (see that function), so every
 * match is deterministic and unique per event without anything extra here.
 * `CoordinationContext` only ever carries `eventId` / `teamIds` (the SDK
 * contract), so there is nothing else a plugin could seed from, and nothing
 * this wrapper needs to derive.
 *
 * ## Config
 *
 * New matches use STREAMING_ORDER_CONFIG (one Order at a 30 ± 10 second interval,
 * with 180-second deadlines). Existing states retain their stored config.
 * tickOnRequest asks the host to advance its own clock before reads/moves;
 * the reducer ignores stale clocks from concurrent requests.
 *
 * ## Wire safety (Issue #486 PR3 independent review, High #1 + #2)
 *
 * `../game/src/types.ts`'s `CryptoBattleState` / `CryptoBattleOp` are
 * JSON-safe by construction (every field that used to be a raw `bigint` --
 * `TeamState.secret`, `StoredShare.value`, `CryptoBattleConfig.prime`, the
 * hunt op's `recoveredSecret` -- is a stringified decimal instead; see that
 * file's "JSON-SAFETY INVARIANT" doc comment). That is load-bearing here,
 * not incidental: TenkaCloud's `CoordinationOpBodySchema` is
 * `{ op: z.unknown() }` (no shape validation before `op` reaches
 * `validateOp` below), and `CryptoBattleState` has to round-trip through
 * Turso/DynamoDB between calls -- neither can carry a `bigint`. Nothing in
 * THIS file has to know that; it is `reducer.ts`'s `validateOp` "hunt"
 * branch that parses the untrusted `recoveredSecret` string (via
 * `decimal.ts`'s exported `parseCanonicalDecimal`) and
 * `reducer.ts`'s other functions that convert at the `bigint` <-> string
 * boundary, so this wrapper stays a pure forward either way.
 *
 * ## Upstream roster gap: closed
 *
 * This header used to record that TenkaCloud's `coordination-handler.ts`
 * resolved `ctx.teamIds: [item.teamId]` -- the requesting team alone -- so a
 * live match's `state.teams` only ever held the caller and `validateOp`'s hunt
 * branch could never resolve a real `state.teams[op.targetTeamId]`. That gap
 * (TenkaCloud#3053) was fixed by TenkaCloud PR #3061: `resolveEventRoster` now
 * passes every team deployed against the same `(tenant, event, problemId)`,
 * sorted by teamId so the roster is identical whichever team's request
 * materialises the state first.
 *
 * What remains is a sequencing constraint, not a blocker: `initialState` runs
 * once, on the first op, so a team that deploys after that is absent from
 * `state.teams`. Start the match only after every team's deploy completes.
 * See OPERATOR.md's "Known gaps" for the operator-facing version.
 *
 * ## projectForTeam: not defensively wrapped here, on purpose
 *
 * `reducer.ts`'s `projectForTeam` throws only for a `teamId` outside
 * `ctx.teamIds` -- a caller invariant violation (every legitimate dispatcher
 * call passes a teamId drawn from the same `ctx.teamIds` that built
 * `state.teams`), not a recoverable "team did something odd" case. The SDK's
 * own `safeProjectForTeam` (used by
 * `TenkaCloud/infrastructure/lib/problem-deploy/handlers/participant-handler/coordination-handler.ts`)
 * is the documented fail-safe layer for the host; adding a second `try/catch`
 * here that swallows that throw and returns a fabricated fallback would
 * convert a real bug into a silently wrong-shaped success, which this repo's
 * `AGENTS.md` guardrail on failure handling rules out ("障害を... silent
 * fallback へ変換して隠さない"). So `projectForTeam` below is a direct,
 * unwrapped forward -- the "does not gratuitously throw" requirement is
 * already met structurally, because a correctly-driven dispatcher never
 * hits that throw path.
 */
import { scoreReasons } from "../game/src/score-reasons.ts";
import { defineCoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import {
  applyOp,
  initialState,
  migrateState,
  projectForTeam,
  STATE_SCHEMA_VERSION,
  STREAMING_ORDER_CONFIG,
  tick,
  validateOp,
} from "../game/src/reducer.ts";
import type { CryptoBattleOp, CryptoBattleProjection, CryptoBattleState } from "../game/src/types.ts";

/**
 * [Issue #659] The match's own scores, handed to the platform.
 *
 * The whole point of this Battle is decided here — `metadata.json` says
 * 「試合中の得点はすべてここで判定される」 — but nothing carried that number to
 * the scoreboard, so the portal showed 0 for a team that had been playing for
 * an hour. Absolute values, not deltas: the plugin is the authority and the
 * platform copies the current figure, which is also what makes a retried write
 * harmless.
 */
function teamScores(state: CryptoBattleState): Readonly<Record<string, number>> {
  const scores: Record<string, number> = {};
  for (const [teamId, team] of Object.entries(state.teams)) scores[teamId] = team.score;
  return scores;
}

export default defineCoordinationPlugin<CryptoBattleState, CryptoBattleOp, CryptoBattleProjection>({
  initialState: ctx => initialState(ctx, STREAMING_ORDER_CONFIG),
  validateOp,
  applyOp,
  tick,
  tickOnRequest: true,
  projectForTeam,
  teamScores,
  scoreReasons,
  // [Issue #679 / TenkaCloud#3150, #709] Every real shape change to
  // `CryptoBattleState` bumps this (the SDK's rule: "State の形を変えたら必ず
  // この値を上げる"): v2 for the compact ledger, v3 for the sudoku PROVE (a new
  // ledger kind, `publicPuzzles`, per-team hunted lists) -- see
  // `STATE_SCHEMA_VERSION`'s doc comment in reducer.ts for why the bump is
  // what keeps a rollback safe. `migrateState` is forwarded directly,
  // unwrapped, the same "thin wrapper" way every other hook above is -- it IS
  // this plugin's `migrateState`, which is what lets
  // `coordination-plugin.test.ts` assert identity rather than merely "is a
  // function".
  stateSchemaVersion: STATE_SCHEMA_VERSION,
  migrateState,
});
