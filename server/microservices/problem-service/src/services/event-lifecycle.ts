/**
 * イベントライフサイクル管理
 *
 * ステータス遷移の検証と実行
 *
 * 有効な遷移:
 *   draft → scheduled
 *   scheduled → active
 *   scheduled → cancelled
 *   active → paused
 *   active → completed
 *   paused → active
 *   paused → cancelled
 *   completed → cancelled
 */

import type { EventStatus } from "../types";

const VALID_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
	draft: ["scheduled"],
	scheduled: ["active", "cancelled"],
	active: ["paused", "completed"],
	paused: ["active", "cancelled"],
	completed: ["cancelled"],
	cancelled: [],
};

export class InvalidStatusTransitionError extends Error {
	constructor(
		public readonly currentStatus: EventStatus,
		public readonly targetStatus: EventStatus,
	) {
		super(`無効なステータス遷移です: ${currentStatus} → ${targetStatus}`);
		this.name = "InvalidStatusTransitionError";
	}
}

export function isValidTransition(
	current: EventStatus,
	target: EventStatus,
): boolean {
	const allowed = VALID_TRANSITIONS[current];
	if (!allowed) return false;
	return allowed.includes(target);
}

export function getValidTransitions(status: EventStatus): EventStatus[] {
	return VALID_TRANSITIONS[status] ?? [];
}

export function validateTransition(
	current: EventStatus,
	target: EventStatus,
): void {
	if (!isValidTransition(current, target)) {
		throw new InvalidStatusTransitionError(current, target);
	}
}
