/** Server-authoritative forensic casebook. The browser imports only game/types.ts. */
import { createHash } from "node:crypto";
import { answerMatches, buildCases, L } from "./fixtures.ts";
import type {
	Context,
	Operation,
	Projection,
	State,
	TeamState,
	Validation,
} from "./types.ts";
export type {
	AnswerOp,
	Case,
	Context,
	Evidence,
	HintOp,
	Localized,
	Operation,
	Projection,
	Question,
	Result,
	State,
	Validation,
} from "./types.ts";
export const STATE_SCHEMA_VERSION = 2 as const;
export const MAX_RECEIPTS = 64;
export const MAX_OPERATIONS_PER_TEAM = 1_000_000;
const unsafeKey = (s: string) =>
	["__proto__", "prototype", "constructor"].includes(s);
const validTeam = (id: unknown): id is string =>
	typeof id === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9_:.@/-]{0,127}$/.test(id) &&
	!unsafeKey(id);
const has = (o: object, key: string) => Object.hasOwn(o, key);
const fail = (error: string): Validation => ({ ok: false, error });
const progressKey = (caseId: string, questionId: string) =>
	`${caseId}/${questionId}`;

/** Host contract: never silently expand an in-progress v1 event or rebuild its state.
 * Existing events keep their pinned v1 bundle. This edition starts new v2 matches.
 */
export function migrateState(_state: unknown, _fromVersion: number): State {
  throw new Error("forensic_casebook_new_event_required");
}

/** Practice reset creates a NEW state with a NEW server secret/event; competition exposes no reset op. */
export function initialState(
	ctx: Context,
	options: { generation?: number } = {},
): State {
	if (
		!ctx ||
		typeof ctx.eventId !== "string" ||
		ctx.eventId.length < 1 ||
		ctx.eventId.length > 256 ||
		/[\x00-\x1f]/.test(ctx.eventId)
	)
		throw new Error("invalid_event");
	if (
		typeof ctx.matchSecret !== "string" ||
		!/^[A-Za-z0-9+\/_=-]{32,128}$/.test(ctx.matchSecret)
	)
		throw new Error("server_secret_required");
	if (
		!Array.isArray(ctx.teamIds) ||
		ctx.teamIds.length < 1 ||
		ctx.teamIds.length > 100 ||
		ctx.teamIds.some((id) => !validTeam(id)) ||
		new Set(ctx.teamIds).size !== ctx.teamIds.length
	)
		throw new Error("invalid_roster");
	const generation = options.generation ?? 1;
	if (
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		generation > 1_000_000
	)
		throw new Error("invalid_generation");
	const state: State = {
		schemaVersion: 2,
		eventId: ctx.eventId,
		matchSecret: ctx.matchSecret,
		generation,
		teams: {},
	};
	for (const teamId of ctx.teamIds) {
		const progress = Object.fromEntries(
			buildCases(state, teamId).flatMap((c) =>
				c.questions.map((q) => [
					progressKey(c.id, q.id),
					{ solved: false, attempts: 0, unlockedHints: 0 },
				]),
			),
		);
		state.teams[teamId] = {
			score: 0,
			revision: 0,
			progress,
			receipts: [],
			lastResult: null,
		};
	}
	return state;
}

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	// Do not execute accessors on untrusted objects, even in non-HTTP callers.
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(d) => "value" in d,
	);
}
function shape(op: unknown): op is Operation {
	if (!record(op)) return false;
	const common = [
		"kind",
		"id",
		"revision",
		"generation",
		"caseId",
		"questionId",
	];
	const extra =
		op.kind === "answer"
			? ["answer", "evidenceIds"]
			: op.kind === "hint"
				? ["rung"]
				: null;
	if (
		!extra ||
		Object.keys(op).length !== common.length + extra.length ||
		![...common, ...extra].every((k) => has(op, k))
	)
		return false;
	if (
		typeof op.id !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(op.id)
	)
		return false;
	if (
		typeof op.revision !== "number" ||
		!Number.isSafeInteger(op.revision) ||
		op.revision < 0
	)
		return false;
	if (
		typeof op.generation !== "number" ||
		!Number.isSafeInteger(op.generation) ||
		op.generation < 1 ||
		op.generation > 1_000_000
	)
		return false;
	if (
		typeof op.caseId !== "string" ||
		!/^[a-z]{1,20}$/.test(op.caseId) ||
		typeof op.questionId !== "string" ||
		!/^[a-z]{1,20}$/.test(op.questionId)
	)
		return false;
	if (op.kind === "hint")
		return Number.isInteger(op.rung) && [1, 2, 3].includes(op.rung as number);
	return (
		typeof op.answer === "string" &&
		op.answer.length > 0 &&
		op.answer.length <= 512 &&
		Array.isArray(op.evidenceIds) &&
		op.evidenceIds.length <= 4 &&
		op.evidenceIds.every(
			(id) => typeof id === "string" && /^[A-Z]-[A-Z]{2,20}$/.test(id),
		) &&
		new Set(op.evidenceIds).size === op.evidenceIds.length
	);
}
function opDigest(op: Operation): string {
	const values =
		op.kind === "answer"
			? [
					op.kind,
					op.id,
					op.revision,
					op.generation,
					op.caseId,
					op.questionId,
					op.answer,
					[...op.evidenceIds].sort(),
				]
			: [
					op.kind,
					op.id,
					op.revision,
					op.generation,
					op.caseId,
					op.questionId,
					op.rung,
				];
	return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function validateOp(
	state: State,
	teamId: string,
	input: unknown,
): Validation {
	if (state.schemaVersion !== STATE_SCHEMA_VERSION) return fail("incompatible_state");
	if (!validTeam(teamId) || !has(state.teams, teamId))
		return fail("unknown_team");
	if (!shape(input)) return fail("invalid_operation");
	if (input.generation !== state.generation) return fail("stale_generation");
	const team = state.teams[teamId]!;
	const receipt = team.receipts.find((r) => r.id === input.id);
	if (receipt)
		return receipt.digest === opDigest(input)
			? { ok: true }
			: fail("id_conflict");
	if (input.revision !== team.revision) return fail("stale_revision");
	if (team.revision >= MAX_OPERATIONS_PER_TEAM) return fail("operation_limit");
	const cases = buildCases(state, teamId);
	const c = cases.find((c) => c.id === input.caseId);
	const q = c?.questions.find((q) => q.id === input.questionId);
	if (!c || !q) return fail("unknown_question");
	const p = team.progress[progressKey(c.id, q.id)]!;
	if (p.solved && input.kind === "answer") return fail("already_solved");
	if (
		input.kind === "answer" &&
		input.evidenceIds.some((id) => !c.evidence.some((e) => e.id === id))
	)
		return fail("invalid_evidence");
	if (input.kind === "hint" && input.rung !== p.unlockedHints + 1)
		return fail("hint_sequence");
	return { ok: true };
}
export function applyOp(state: State, teamId: string, input: unknown): State {
	const validation = validateOp(state, teamId, input);
	if (!validation.ok) throw new Error(validation.error);
	const op = input as Operation;
	const oldTeam = state.teams[teamId]!;
	if (oldTeam.receipts.some((r) => r.id === op.id)) return state;
	const c = buildCases(state, teamId).find((c) => c.id === op.caseId)!;
	const q = c.questions.find((q) => q.id === op.questionId)!;
	const key = progressKey(c.id, q.id);
	const p = { ...oldTeam.progress[key]! };
	const team: TeamState = {
		...oldTeam,
		revision: oldTeam.revision + 1,
		progress: { ...oldTeam.progress, [key]: p },
		receipts: [...oldTeam.receipts, { id: op.id, digest: opDigest(op) }].slice(
			-MAX_RECEIPTS,
		),
	};
	if (op.kind === "hint") {
		p.unlockedHints = op.rung;
		team.lastResult = {
			kind: "hint",
			caseId: c.id,
			questionId: q.id,
			status: "hint",
			pointsAwarded: 0,
			message: L(
				`ヒント ${op.rung}/3 を開きました。減点はありません。`,
				`Hint ${op.rung}/3 opened. No points deducted.`,
			),
		};
	} else {
		p.attempts += 1;
		const cited = [...op.evidenceIds].sort();
		const prior = c.questions.slice(0, c.questions.findIndex((entry) => entry.id === q.id));
		const ready = c.id !== "endpoint" || prior.every((entry) => oldTeam.progress[progressKey(c.id, entry.id)]?.solved);
		const correct = ready &&
			answerMatches(q, op.answer) &&
			JSON.stringify(cited) === JSON.stringify([...q.citations].sort());
		p.solved = correct;
		if (correct) team.score += q.points;
		team.lastResult = {
			kind: "answer",
			caseId: c.id,
			questionId: q.id,
			status: correct ? "correct" : "incorrect",
			pointsAwarded: correct ? q.points : 0,
			message: correct
				? L(
						`正解。結論と根拠がそろいました。+${q.points}点。解説を確認してください。`,
						`Correct conclusion and supporting evidence. +${q.points} points. Read the explanation.`,
					)
				: L(
						"まだ正解ではありません。回答と、それを支える最小限の証拠を見直してください。減点なしで再挑戦できます。",
						"Not correct yet. Review the answer and its smallest sufficient evidence set. Retry without a penalty.",
					),
		};
	}
	return { ...state, teams: { ...state.teams, [teamId]: team } };
}
export function projectForTeam(state: State, teamId: string): Projection {
	if (state.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error("incompatible_state");
	if (!validTeam(teamId) || !has(state.teams, teamId))
		throw new Error("unknown_team");
	const team = state.teams[teamId]!;
	return {
		teamId,
		score: team.score,
		maxScore: 400,
		revision: team.revision,
		generation: state.generation,
		lastResult: team.lastResult ? structuredClone(team.lastResult) : null,
		cases: buildCases(state, teamId).map((c) => ({
			id: c.id,
			title: c.title,
			intro: c.intro,
			evidence: c.evidence,
			questions: c.questions.map((q) => {
				const p = team.progress[progressKey(c.id, q.id)]!;
				return {
					id: q.id,
					prompt: q.prompt,
					format: q.format,
					points: q.points,
					hints: q.hints.slice(0, p.unlockedHints),
					totalHints: 3 as const,
					solved: p.solved,
					attempts: p.attempts,
					unlockedHints: p.unlockedHints,
					...(p.solved ? { explanation: q.explanation } : {}),
				};
			}),
		})),
	};
}
/** Absolute authoritative scores: retries never create score deltas. */
export function teamScores(state: State): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(state.teams).map(([teamId, team]) => [teamId, team.score]),
	);
}
export default {
	initialState,
	validateOp,
	applyOp,
	projectForTeam,
	teamScores,
	stateSchemaVersion: STATE_SCHEMA_VERSION,
	migrateState,
};
