import { contractId } from "./ledger-codec.ts";
import type { CryptoBattleOp, CryptoBattleState } from "./types.ts";

/** Public classification only. Never copy an answer, recovered secret, proof, or target ID. */
export function scoreReasons(
  before: CryptoBattleState,
  after: CryptoBattleState,
  cause: { readonly kind: "op"; readonly teamId: string; readonly op: CryptoBattleOp } | { readonly kind: "tick" },
): Readonly<Record<string, string>> {
  const reasons: Record<string, string> = {};
  for (const [teamId, team] of Object.entries(after.teams)) {
    if (team.score === before.teams[teamId]?.score) continue;
    const duelPoints = newDuelPoints(before, after, teamId);
    const lastHunt = team.lastRpsHunt;
    const delta = team.score - (before.teams[teamId]?.score ?? 0);
    // A single opening can settle several predictions; the final result may have zero
    // points after an earlier penalty reached the floor. Compare the net change too.
    const huntSettled = lastHunt && delta !== duelPoints && JSON.stringify(lastHunt) !== JSON.stringify(before.teams[teamId]?.lastRpsHunt);
    if (cause.kind === "op" && cause.op.kind === "rps-open" && huntSettled) {
      reasons[teamId] = duelPoints > 0 ? "duel-hunt" : "hunt";
    } else if (cause.kind === "tick" && duelPoints > 0) {
      reasons[teamId] = delta === duelPoints ? "duel" : "duel-deadline";
    } else {
      reasons[teamId] = cause.kind === "tick" ? "deadline" : operationReason(cause.op.kind, teamId !== cause.teamId);
    }
  }
  return reasons;
}

function operationReason(kind: CryptoBattleOp["kind"], otherTeam: boolean): string {
  switch (kind) {
    case "claim-steal": return "item-answer";
    case "use-steal": return otherTeam ? "item-stolen" : "item-steal";
    case "schnorr-commit":
    case "schnorr-response":
    case "prove-sudoku": return "prove";
    case "anamorphic": return "anamorphic";
    case "stark": return "stark";
    case "io": return "io";
    case "ec": return "ec";
    case "evolution": return "evolution";
    case "snark": return "snark";
    case "cipher": return "cipher";
    case "leak": return "leak";
    case "fhe": return "fhe";
    case "mpc": return "mpc";
    case "rps-commit":
    case "rps-open": return "duel";
    case "hunt":
    case "hunt-rotor":
    case "hunt-rsa":
    case "hunt-cipher":
    case "hunt-sudoku":
    case "hunt-rps": return otherTeam ? "hunted" : "hunt";
    case "rotate": return "rotate";
    case "reveal-hint": return "hint";
    case "declare-lightning":
    case "ready":
    case "start": return "coordination";
  }
}

/** Public completion IDs survive the tick's terminal-Order pruning. */
function newDuelPoints(before: CryptoBattleState, after: CryptoBattleState, teamId: string): number {
  let points = 0;
  const completed = new Set(after.teams[teamId]?.completedContractIds.map(c => contractId({ tm: teamId, c })));
  const previous = new Set(before.teams[teamId]?.completedContractIds.map(c => contractId({ tm: teamId, c })));
  const retained = new Map(after.contracts.map(order => [order.id, order]));
  for (const order of before.contracts) {
    if (order.teamId !== teamId || order.task.kind !== "rps-duel" || order.status !== "open") continue;
    if (!completed.has(order.id) || previous.has(order.id)) continue;
    const settled = retained.get(order.id);
    if (settled?.rps?.outcome === "draw") points += after.config.scores.duelDraw;
    // Only tick prunes Orders. An open DUEL newly marked completed by tick is a
    // forfeit win; a timeout loss is expired and never adds a completion ID.
    if (!settled || settled.rps?.outcome === "win" || settled.rps?.outcome === "forfeit-win") points += after.config.scores.duelWin;
  }
  return points;
}
