/** Test reader of participant-visible records. No private game, answer key or state imports. */
import assert from "node:assert/strict";

export interface PublicEvidence {
  id: string;
  name: string;
  content: string;
  sha256: string;
}
export interface PublicQuestion {
  id: string;
  points: number;
  solved: boolean;
  attempts: number;
  unlockedHints: number;
  hints: { en: string; ja: string }[];
  explanation?: { en: string; ja: string };
}
export interface ForensicProjection {
  teamId: string;
  score: number;
  revision: number;
  generation: number;
  lastResult: null | {
    status: "correct" | "incorrect" | "hint";
    pointsAwarded: number;
  };
  cases: {
    id: string;
    evidence: PublicEvidence[];
    questions: PublicQuestion[];
  }[];
}

/** Join the administrative action's session to its successful authentication record. */
export function publicIdentityAnswer(identityContent: string, actionContent: string): string {
  const identity = JSON.parse(identityContent) as {
    synthetic: boolean;
    events: { session: string; account: string; result: string }[];
  };
  const cloud = JSON.parse(actionContent) as {
    synthetic: boolean;
    events: { session: string; operation: string; result: string }[];
  };
  assert.equal(identity.synthetic, true);
  assert.equal(cloud.synthetic, true);
  const action = cloud.events.find(
    (event) => event.operation === "EnableExternalExport" && event.result === "success",
  );
  assert.ok(action, "The public action evidence records the export setting change.");
  const login = identity.events.find(
    (event) => event.session === action.session && event.result === "accepted",
  );
  assert.ok(login, "The public authentication evidence links the same session to an account.");
  return login.account;
}
