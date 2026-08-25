import { describe, expect, it } from "vitest";
import battle from "../../../problems/battles/ac26-crypto-battle/coordination/crypto-battle.ts";
import { makeCoordinationScopeResolver } from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import { fakeParticipantSharedWithItems } from "./coordination.test-helpers.js";

/**
 * Issue #3053 の受け入れ条件を、実 plugin で観測する。
 *
 * dispatcher が requester 1 チームだけの ctx を渡していた頃は、plugin の initialState が
 * その 1 チームしか state に登録できず、相手チームを対象にする op — ac26-crypto-battle の
 * コアメカニクスである hunt — が必ず `unknown team` で reject されていた。つまり
 * 「チーム間 interaction する plugin が原理的に成立しない」状態だった。
 *
 * ここは resolver から plugin までを繋いで、roster が実際に state へ届くことを見る
 * (unit test 側の coordination-handler.test.ts は resolver の出力だけを見ている)。
 */
describe("ac26-crypto-battle over the dispatcher's ctx", () => {
  it("registers every team, so an op against another team is not unknown_team", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeParticipantSharedWithItems([
        { tenantId: "tn1", eventId: "e1", teamId: "alpha", problemId: "ac26-crypto-battle" },
        { tenantId: "tn1", eventId: "e1", teamId: "bravo", problemId: "ac26-crypto-battle" },
      ]),
      { "ac26-crypto-battle": { plugin: "coordination/crypto-battle.ts" } },
    );
    const scope = await resolve("key");
    expect(scope).not.toBeNull();
    if (!scope) return;
    expect(scope.ctx.teamIds).toEqual(["alpha", "bravo"]);
    const state: { teams: Record<string, unknown> } = battle.initialState(scope.ctx);
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "bravo"]);
  });
});
