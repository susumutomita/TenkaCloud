import { boosterStartAt } from "./booster.ts";
import type { Contract, CryptoBattleState, EndgameLightning, LightningCard, LightningOutcome, LightningProjection } from "./types.ts";

const duration = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const outcomes: readonly LightningOutcome[] = ["hit", "miss", "leak", "deadline", "rotate", "ended"];

/** Historical ranks cannot be reconstructed from a later score. Never grant on reload. */
export function storedLightning(state: CryptoBattleState): EndgameLightning {
  const stored = state.endgameLightning;
  if (stored === undefined) {
    const boundary = boosterStartAt(state);
    return { status: boundary !== undefined && (state.nowMs ?? 0) >= boundary ? "unavailable" : "pending" };
  }
  if (!stored || typeof stored !== "object" || !["pending", "unavailable", "awarded"].includes(stored.status)) {
    throw new Error("lightning: invalid distribution");
  }
  if (stored.status === "awarded") {
    if (!stored.cards || typeof stored.cards !== "object" || Array.isArray(stored.cards)) throw new Error("lightning: invalid cards");
    for (const [teamId, card] of Object.entries(stored.cards)) {
      if (!Object.hasOwn(state.teams, teamId) || !card || typeof card !== "object"
        || !["available", "armed", "spent", "unused-expired"].includes(card.status)) throw new Error("lightning: invalid recipient/card");
      if (card.status === "armed" || card.status === "spent") {
        if (typeof card.contractId !== "string" || !card.contractId.startsWith(`${teamId}-c`)
          || !duration(card.points) || !duration(card.expiresAtMs)
          || (card.status === "spent" && !outcomes.includes(card.outcome))) throw new Error("lightning: invalid target/result");
      }
    }
  }
  return stored;
}

/** Bottom two roster places, including ties at the cutoff; a two-team match gives only last place. */
export function awardLightning(boundary: CryptoBattleState): EndgameLightning {
  const teams = Object.values(boundary.teams).sort((a, b) => a.score - b.score || a.teamId.localeCompare(b.teamId));
  const cutoff = teams.length < 2 ? undefined : teams[teams.length === 2 ? 0 : 1]?.score;
  return { status: "awarded", cards: Object.fromEntries(teams.filter(t => cutoff !== undefined && t.score <= cutoff)
    .map(t => [t.teamId, { status: "available" as const }])) };
}

function cardFor(state: CryptoBattleState, teamId: string): LightningCard | undefined {
  const distribution = storedLightning(state);
  return distribution.status === "awarded" ? distribution.cards[teamId] : undefined;
}

export function lightningEligible(state: CryptoBattleState, contract: Contract): boolean {
  return state.phase === "endgame" && cardFor(state, contract.teamId)?.status === "available"
    && contract.status === "open" && contract.expiresAtMs > (state.nowMs ?? 0)
    && contract.allowedMethods.some(method => ["prove", "cipher", "fhe", "mpc", "ec", "io", "snark", "stark", "anamorphic", "evolution"].includes(method))
    && contract.answerAttempted === false && contract.cipherFailed !== true;
}

export function armLightning(state: CryptoBattleState, teamId: string, contractId: string): CryptoBattleState {
  const distribution = storedLightning(state);
  const contract = state.contracts.find(c => c.id === contractId && c.teamId === teamId);
  if (distribution.status !== "awarded" || !contract || !lightningEligible(state, contract)) {
    throw new Error("lightning: invalid declaration reached apply; validate first");
  }
  return { ...state, endgameLightning: { ...distribution, cards: { ...distribution.cards,
    [teamId]: { status: "armed", contractId, points: contract.points * 2, expiresAtMs: contract.expiresAtMs },
  } } };
}

/** Calculation rewards only. LEAK and duel outcome scoring do not call this helper. */
export function lightningBonus(state: CryptoBattleState, contract: Contract): number {
  const card = cardFor(state, contract.teamId);
  return contract.cipherFailed !== true && card && (card.status === "armed" || (card.status === "spent" && card.outcome === "hit"))
    && card.contractId === contract.id ? card.points / 2 : 0;
}

/** Terminal card records survive Order pruning/checkpoint reload; no further allocation can occur. */
export function settleLightning(state: CryptoBattleState): CryptoBattleState {
  const distribution = storedLightning(state);
  if (distribution.status !== "awarded") return state;
  let changed = false;
  const cards = { ...distribution.cards };
  for (const [teamId, card] of Object.entries(cards)) {
    if (card.status === "available" && state.phase === "ended") {
      cards[teamId] = { status: "unused-expired" }; changed = true;
    } else if (card.status === "armed") {
      const contract = state.contracts.find(c => c.id === card.contractId && c.teamId === teamId);
      // Vigenère's ordinary reward forfeiture also applies to the multiplier.
      const proofMiss = contract?.status === "completed" && contract.resolution === "prove" && contract.schnorr?.outcome === "miss";
      const points = contract?.cipherFailed === true || proofMiss ? 0 : card.points;
      const outcome: LightningOutcome | undefined = contract?.status === "completed"
        ? proofMiss ? "miss" : contract.resolution === "leak" ? "leak" : "hit"
        : contract?.status === "expired" ? contract.expiryCause === "rotate" ? "rotate" : "deadline"
        : (state.nowMs ?? 0) >= card.expiresAtMs ? "deadline"
        : state.phase === "ended" ? "ended" : undefined;
      if (outcome) { cards[teamId] = { ...card, points, status: "spent", outcome }; changed = true; }
      else if (points !== card.points) { cards[teamId] = { ...card, points }; changed = true; }
    }
  }
  return changed ? { ...state, endgameLightning: { ...distribution, cards } } : state;
}

export function projectLightning(state: CryptoBattleState, teamId: string): LightningProjection {
  const distribution = storedLightning(state), card = cardFor(state, teamId);
  const startAfterMs = state.config.phaseBoundaries.pressureToEndgameMs;
  const boundary = boosterStartAt(state), now = state.nowMs ?? 0;
  const common = { startAfterMs, startsInMs: boundary === undefined ? undefined : Math.max(0, boundary - now), remainingMs: 0 };
  if (distribution.status === "unavailable") return { ...common, status: "unavailable" };
  if (boundary === undefined) return { ...common, status: "waiting" };
  if (distribution.status === "pending") return { ...common, status: "scheduled" };
  if (!card) return { ...common, status: "ineligible" };
  if (card.status === "armed" || card.status === "spent") return { ...common, status: card.status,
    contractId: card.contractId, points: card.points, ...(card.status === "spent" ? { outcome: card.outcome } : {}),
    remainingMs: card.status === "armed" ? Math.max(0, Math.min(card.expiresAtMs, state.startedAtMs! + state.config.matchDurationMs) - now) : 0,
  };
  return { ...common, status: card.status };
}
