import { describe, expect, it } from "vitest";
import { parseTeamCountInput, resizeTeamRows, validateTeamRows } from "../../src/pages/EventCreate";

describe("resizeTeamRows", () => {
  it("同じ team 数なら同じ配列参照を返すべき", () => {
    const rows = [{ internalSlug: "team-1", awsAccountId: "111111111111" }];

    expect(resizeTeamRows(rows, 1)).toBe(rows);
  });

  it("team 数を減らすと末尾の row を捨てるべき", () => {
    expect(
      resizeTeamRows(
        [
          { internalSlug: "team-1", awsAccountId: "111111111111" },
          { internalSlug: "team-2", awsAccountId: "222222222222" },
        ],
        1,
      ),
    ).toEqual([{ internalSlug: "team-1", awsAccountId: "111111111111" }]);
  });

  it("team 数を増やすと既存 row を保持して空の新 row を追加すべき", () => {
    expect(resizeTeamRows([{ internalSlug: "team-1", awsAccountId: "111111111111" }], 3)).toEqual([
      { internalSlug: "team-1", awsAccountId: "111111111111" },
      { internalSlug: "team-2", awsAccountId: "" },
      { internalSlug: "team-3", awsAccountId: "" },
    ]);
  });

  it("負数は 0 件として扱うべき", () => {
    expect(resizeTeamRows([{ internalSlug: "team-1", awsAccountId: "111111111111" }], -1)).toEqual(
      [],
    );
  });
});

describe("validateTeamRows", () => {
  it("slug/account が全て有効で重複がなければ valid を返すべき", () => {
    expect(
      validateTeamRows([
        { internalSlug: "team-1", awsAccountId: "111111111111" },
        { internalSlug: "team-2", awsAccountId: "222222222222" },
      ]),
    ).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      hasDuplicateSlug: false,
    });
  });

  it("不正 slug/account と重複 slug を検出すべき", () => {
    expect(
      validateTeamRows([
        { internalSlug: "Team_1", awsAccountId: "111" },
        { internalSlug: "Team_1", awsAccountId: "222222222222" },
      ]),
    ).toEqual({
      allSlugsValid: false,
      allAccountsValid: false,
      hasDuplicateSlug: true,
    });
  });
});

describe("parseTeamCountInput", () => {
  it("数字だけを取り出して上限まで clamp すべき", () => {
    expect(parseTeamCountInput("abc12345")).toBe(99);
  });

  it("空文字や数字なし入力は undefined にすべき", () => {
    expect(parseTeamCountInput("")).toBeUndefined();
    expect(parseTeamCountInput("abc")).toBeUndefined();
  });

  it("0 は 0 のまま返すべき", () => {
    expect(parseTeamCountInput("0")).toBe(0);
  });
});
