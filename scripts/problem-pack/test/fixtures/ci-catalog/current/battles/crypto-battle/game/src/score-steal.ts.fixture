import { createHash, createHmac } from "node:crypto";
import type { Contract, CoordinationContext, CryptoBattleState, ValidateResult } from "./types.ts";

export interface StealTask {
  readonly kind: "ssm-decrypt";
  readonly ciphertext: number;
  readonly nonce: string;
  readonly parameterName: string;
  readonly consoleUrl: string;
}
interface Material {
  readonly key: number;
  readonly receipt: string;
  readonly parameterName: string;
  readonly consoleUrl: string;
  readonly status: "waiting" | "offered" | "held" | "spent";
}
export interface StealState {
  readonly players: Readonly<Record<string, Material>>;
  readonly transfers: readonly { from: string; to: string; points: number; atMs: number }[];
}
export type StealOp =
  | {
      readonly kind: "claim-steal";
      readonly contractId: string;
      readonly nonce: string;
      readonly material: string;
      readonly answer: number;
    }
  | { readonly kind: "use-steal"; readonly nonce: string; readonly targetTeamId: string };
export interface StealView {
  readonly nonce: string;
  readonly held: boolean;
  readonly targets: readonly { teamId: string; name: string; score: number; points: number; protected: boolean }[];
  readonly notices: readonly { from: string; to: string; points: number; atMs: number }[];
}

/** Same secret-injection path as hello-world. Never accept these values from an op. */
export function initialSteal(ctx: CoordinationContext): StealState | undefined {
  const inputs = ctx.deploymentInputs ?? {};
  if (!ctx.teamIds.some((id) => inputs[id]?.CoordinationItemEnabled === "true")) return undefined;
  const players: Record<string, Material> = {};
  for (const id of ctx.teamIds) {
    const input = inputs[id];
    if (input?.CoordinationItemEnabled !== "true")
      throw new Error("Score item settings must match across completed team deployments");
    let value: unknown;
    try {
      value = JSON.parse(input.CoordinationPrivateItem ?? "");
    } catch {
      throw new Error("Score item deployment material is missing");
    }
    const material = value as Record<string, unknown>;
    if (
      !material ||
      !Number.isInteger(material.key) ||
      Number(material.key) < 1 ||
      Number(material.key) > 9 ||
      typeof material.receipt !== "string" ||
      !/^[A-Za-z0-9]{32}$/.test(material.receipt)
    )
      throw new Error("Invalid score item deployment material");
    const parameterName = input.CoordinationParameterName;
    const consoleUrl = input.CoordinationParameterConsoleUrl;
    if (
      !parameterName?.startsWith("/tc-") ||
      parameterName.length > 92 ||
      !consoleUrl ||
      consoleUrl.length > 300 ||
      !/^https:\/\/[a-z0-9-]+\.console\.aws\.amazon\.com\/systems-manager\/parameters\//.test(
        consoleUrl ?? "",
      )
    )
      throw new Error("Invalid score item resource location");
    players[id] = {
      key: Number(material.key),
      receipt: material.receipt,
      parameterName,
      consoleUrl: consoleUrl!,
      status: "waiting",
    };
  }
  return { players, transfers: [] };
}

export function stealTask(state: CryptoBattleState, teamId: string, contractId: string): StealTask {
  const material = state.scoreSteal!.players[teamId]!;
  const digest = createHmac("sha256", state.seed)
    .update(`score-item:${teamId}:${contractId}`)
    .digest();
  return {
    kind: "ssm-decrypt",
    ciphertext: ((digest[0]! % 10) + material.key) % 10,
    nonce: digest.subarray(1, 17).toString("hex"),
    parameterName: material.parameterName,
    consoleUrl: material.consoleUrl,
  };
}

export function validateSteal(
  state: CryptoBattleState,
  teamId: string,
  op: StealOp,
): ValidateResult {
  const item = state.scoreSteal;
  const me = item?.players[teamId];
  const reject = (error: string): ValidateResult => ({ ok: false, error });
  if (!item || !me) return reject("Score item is disabled");
  if (op.kind === "use-steal") {
    if (op.nonce !== itemNonce(state, teamId)) return reject("Score item belongs to another match");
    if (me.status !== "held") return reject("No unused score item");
    if (
      typeof op.targetTeamId !== "string" ||
      op.targetTeamId === teamId ||
      !Object.hasOwn(state.teams, op.targetTeamId) ||
      state.teams[op.targetTeamId]!.score <= 0
    )
      return reject("Choose another team with points");
    if (item.transfers.some((t) => t.from === op.targetTeamId))
      return reject("This team has already lost points to an item");
    return { ok: true };
  }
  const order = state.contracts.find((c) => c.id === op.contractId && c.teamId === teamId);
  if (
    me.status !== "offered" ||
    !order ||
    order.status !== "open" ||
    order.expiresAtMs <= (state.nowMs ?? 0) ||
    order.task.kind !== "ssm-decrypt" ||
    op.nonce !== order.task.nonce
  )
    return reject("Score item Order is unavailable");
  if (
    typeof op.material !== "string" ||
    op.material.length > 512 ||
    !Number.isInteger(op.answer) ||
    op.answer < 0 ||
    op.answer > 9
  )
    return reject("Paste the AWS value and enter one digit (0–9)");
  return { ok: true };
}

function correct(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<StealOp, { kind: "claim-steal" }>,
): boolean {
  const me = state.scoreSteal!.players[teamId]!;
  const order = state.contracts.find((c) => c.id === op.contractId)!;
  if (order.task.kind !== "ssm-decrypt") return false;
  try {
    const value = JSON.parse(op.material);
    return (
      value?.key === me.key &&
      typeof value.receipt === "string" &&
      createHash("sha256").update(value.receipt).digest("hex") ===
        createHash("sha256").update(me.receipt).digest("hex") &&
      op.answer === (order.task.ciphertext - me.key + 10) % 10
    );
  } catch {
    return false;
  }
}

export function applySteal(
  state: CryptoBattleState,
  teamId: string,
  op: StealOp,
): CryptoBattleState {
  if (!validateSteal(state, teamId, op).ok || state.phase === "waiting" || state.phase === "ended")
    return state;
  const item = state.scoreSteal!;
  const me = item.players[teamId]!;
  if (op.kind === "claim-steal") {
    if (!correct(state, teamId, op)) {
      const team = state.teams[teamId]!;
      return {
        ...state,
        teams: {
          ...state.teams,
          [teamId]: { ...team, score: Math.max(0, team.score - state.config.scores.wrongProve) },
        },
      };
    }
    return {
      ...state,
      scoreSteal: { ...item, players: { ...item.players, [teamId]: { ...me, status: "held" } } },
      contracts: state.contracts.map((c) =>
        c.id === op.contractId
          ? ({ ...c, status: "completed", resolution: "item", lastSubmissionPoints: 0 } as Contract)
          : c,
      ),
      teams: {
        ...state.teams,
        [teamId]: {
          ...state.teams[teamId]!,
          completedContractIds: [...state.teams[teamId]!.completedContractIds, op.contractId],
        },
      },
    };
  }
  const target = state.teams[op.targetTeamId]!;
  const points = Math.min(10, target.score);
  return {
    ...state,
    scoreSteal: {
      players: { ...item.players, [teamId]: { ...me, status: "spent" } },
      transfers: [
        ...item.transfers,
        { from: op.targetTeamId, to: teamId, points, atMs: state.nowMs ?? 0 },
      ],
    },
    teams: {
      ...state.teams,
      [teamId]: { ...state.teams[teamId]!, score: state.teams[teamId]!.score + points },
      [op.targetTeamId]: { ...target, score: target.score - points },
    },
  };
}

export function projectSteal(state: CryptoBattleState, teamId: string): StealView | undefined {
  const item = state.scoreSteal;
  if (!item) return undefined;
  return {
    nonce: itemNonce(state, teamId),
    held: item.players[teamId]?.status === "held",
    targets: Object.values(state.teams)
      .filter((t) => t.teamId !== teamId)
      .map((t) => ({
        teamId: t.teamId,
        name: t.teamName ?? t.teamId,
        score: t.score,
        points: Math.min(10, t.score),
        protected: item.transfers.some((x) => x.from === t.teamId),
      })),
    notices: item.transfers.filter((t) => t.from === teamId || t.to === teamId),
  };
}

function itemNonce(state: CryptoBattleState, teamId: string): string {
  return createHmac("sha256", state.seed)
    .update(`use-score-item:${teamId}`)
    .digest("hex")
    .slice(0, 32);
}
