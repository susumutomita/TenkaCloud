import { describe, expect, it } from "vitest";
import {
  BULK_MAX_ENTRIES,
  deriveBulkInputState,
  effectiveRoleNames,
  parseBulkAccountsInput,
} from "./bulk-competitor-accounts";

/**
 * The input this parser has to accept is whatever the operator already has in
 * hand after rolling the bootstrap StackSet out to an OU. That is usually the
 * raw output of `list-stack-instances --output text` — a column of account IDs,
 * not JSON. Requiring them to convert it first would put the manual step back.
 */
describe("parseBulkAccountsInput", () => {
  it("should read the whitespace-separated account IDs the CLI prints", () => {
    const res = parseBulkAccountsInput("222222222222\t333333333333\t444444444444\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accounts.map((a) => a.awsAccountId)).toEqual([
      "222222222222",
      "333333333333",
      "444444444444",
    ]);
    expect(res.defaults).toBeUndefined();
  });

  it("should read a single pasted account ID", () => {
    // `222222222222` is itself valid JSON (a number), so deciding between the
    // two input shapes on JSON.parse succeeding would send the commonest
    // one-line paste down the JSON path and reject it.
    const res = parseBulkAccountsInput("222222222222");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accounts).toEqual([{ awsAccountId: "222222222222" }]);
  });

  it("should say so when something that opens like JSON is malformed", () => {
    const res = parseBulkAccountsInput('{"accounts": [');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("JSON");
  });

  it("should read newline- and comma-separated IDs the same way", () => {
    const res = parseBulkAccountsInput("222222222222,333333333333\n444444444444");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accounts.length).toBe(3);
  });

  it("should name the token it could not read as an account ID", () => {
    const res = parseBulkAccountsInput("222222222222 oops 444444444444");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("oops");
  });

  it("should read the documented JSON object with defaults", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify({
        defaults: { region: "ap-northeast-1", competitorRoleName: "TenkaCloud-acme-deploy-Role" },
        accounts: [
          { awsAccountId: "222222222222", alias: "Team A" },
          { awsAccountId: "333333333333", region: "us-east-1" },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.defaults).toEqual({
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-acme-deploy-Role",
    });
    expect(res.accounts[0]).toEqual({ awsAccountId: "222222222222", alias: "Team A" });
    expect(res.accounts[1]).toEqual({ awsAccountId: "333333333333", region: "us-east-1" });
  });

  it("should keep a per-entry role name alongside the defaults", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify({
        defaults: { competitorRoleName: "Default-Role" },
        accounts: [{ awsAccountId: "222222222222", competitorRoleName: "Row-Role" }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accounts[0]).toEqual({
      awsAccountId: "222222222222",
      competitorRoleName: "Row-Role",
    });
  });

  it("should read a bare array, including plain ID strings inside it", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify(["222222222222", { awsAccountId: "333333333333", alias: "Team B" }]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accounts).toEqual([
      { awsAccountId: "222222222222" },
      { awsAccountId: "333333333333", alias: "Team B" },
    ]);
  });

  it("should reject a misspelled entry key instead of dropping it", () => {
    // parseEntry rebuilds the entry from the keys it recognises, so a typo that
    // slips through here never reaches the backend's strict schema either: the
    // import would "succeed" under the screen's default role or without the
    // intended alias.
    const res = parseBulkAccountsInput(
      JSON.stringify({ accounts: [{ awsAccountId: "222222222222", roleName: "typo" }] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("roleName");
  });

  it("should reject a misspelled defaults key instead of dropping it", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify({
        defaults: { regoin: "ap-northeast-1" },
        accounts: [{ awsAccountId: "222222222222" }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("regoin");
  });

  it("should reject a duplicate ID before the request is sent", () => {
    // The backend rejects it too, but the operator fixes it faster when the
    // screen says so before the round trip.
    const res = parseBulkAccountsInput("222222222222 222222222222");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("222222222222");
  });

  it("should reject more entries than one request may carry", () => {
    const ids = Array.from({ length: BULK_MAX_ENTRIES + 1 }, (_, i) => String(100000000000 + i));
    const res = parseBulkAccountsInput(ids.join("\n"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain(String(BULK_MAX_ENTRIES));
  });

  it("should accept exactly the maximum", () => {
    const ids = Array.from({ length: BULK_MAX_ENTRIES }, (_, i) => String(100000000000 + i));
    expect(parseBulkAccountsInput(ids.join("\n")).ok).toBe(true);
  });

  it("should reject empty input", () => {
    expect(parseBulkAccountsInput("   ").ok).toBe(false);
  });

  it("should reject input that is only separators", () => {
    // Splitting leaves no tokens at all, which is a different path from a
    // string that was already blank before splitting.
    const res = parseBulkAccountsInput(",,, \n ,");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("空");
  });

  it("should reject a bad ID given as a bare string inside the array", () => {
    const res = parseBulkAccountsInput(JSON.stringify({ accounts: ["12345"] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("12345");
  });

  it("should reject JSON whose accounts field is not an array", () => {
    const res = parseBulkAccountsInput(JSON.stringify({ accounts: { awsAccountId: "1" } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("accounts");
  });

  it("should reject an empty accounts array", () => {
    const res = parseBulkAccountsInput(JSON.stringify({ accounts: [] }));
    expect(res.ok).toBe(false);
  });

  it("should point at the offending row by index", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify({ accounts: [{ awsAccountId: "222222222222" }, { awsAccountId: "nope" }] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("accounts[1]");
  });

  it("should reject malformed per-entry region, role name, and alias", () => {
    for (const entry of [
      { awsAccountId: "222222222222", region: "nope" },
      { awsAccountId: "222222222222", competitorRoleName: "bad name!" },
      { awsAccountId: "222222222222", alias: "" },
      { awsAccountId: "222222222222", alias: "x".repeat(121) },
    ]) {
      expect(parseBulkAccountsInput(JSON.stringify({ accounts: [entry] })).ok).toBe(false);
    }
  });

  it("should reject a non-object entry", () => {
    const res = parseBulkAccountsInput(JSON.stringify({ accounts: [42] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("accounts[0]");
  });

  it("should reject malformed defaults", () => {
    for (const defaults of [
      { region: "nope" },
      { competitorRoleName: "bad name!" },
      "not-an-object",
    ]) {
      const res = parseBulkAccountsInput(
        JSON.stringify({ defaults, accounts: [{ awsAccountId: "222222222222" }] }),
      );
      expect(res.ok).toBe(false);
    }
  });

  it("should omit defaults entirely when the object carries none", () => {
    const res = parseBulkAccountsInput(
      JSON.stringify({ defaults: {}, accounts: [{ awsAccountId: "222222222222" }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.defaults).toBeUndefined();
  });
});

/**
 * The screen reveals one set of values to hand competitors, so one IAM Role
 * name. A paste where rows resolve to different roles would hand the wrong
 * RoleName to every row that differs, and their bootstrap would then fail
 * verification — so the resolved set has to be computed exactly the way the
 * backend resolves it (`entry ?? defaults`), screen default included.
 */
describe("effectiveRoleNames", () => {
  it("should fall back to the screen default when nothing else sets a role", () => {
    expect(
      effectiveRoleNames([{ awsAccountId: "222222222222" }], undefined, "Screen-Role"),
    ).toEqual(["Screen-Role"]);
  });

  it("should prefer the pasted defaults over the screen default", () => {
    expect(
      effectiveRoleNames([{ awsAccountId: "222222222222" }], "Pasted-Role", "Screen-Role"),
    ).toEqual(["Pasted-Role"]);
  });

  it("should prefer a per-entry role over both defaults", () => {
    expect(
      effectiveRoleNames(
        [{ awsAccountId: "222222222222", competitorRoleName: "Row-Role" }],
        "Pasted-Role",
        "Screen-Role",
      ),
    ).toEqual(["Row-Role"]);
  });

  it("should report both names when one row overrides the pasted default", () => {
    // The case a per-entry-only check would miss: the set is mixed even though
    // every explicit per-entry value is identical.
    expect(
      effectiveRoleNames(
        [
          { awsAccountId: "222222222222" },
          { awsAccountId: "333333333333", competitorRoleName: "Row-Role" },
        ],
        "Pasted-Role",
        "Screen-Role",
      ),
    ).toEqual(["Pasted-Role", "Row-Role"]);
  });

  it("should report both names when one row overrides the screen default", () => {
    expect(
      effectiveRoleNames(
        [
          { awsAccountId: "222222222222" },
          { awsAccountId: "333333333333", competitorRoleName: "Row-Role" },
        ],
        undefined,
        "Screen-Role",
      ),
    ).toEqual(["Screen-Role", "Row-Role"]);
  });

  it("should collapse rows that all name the same role", () => {
    expect(
      effectiveRoleNames(
        [
          { awsAccountId: "222222222222", competitorRoleName: "Same" },
          { awsAccountId: "333333333333", competitorRoleName: "Same" },
        ],
        undefined,
        "Screen-Role",
      ),
    ).toEqual(["Same"]);
  });
});

describe("deriveBulkInputState", () => {
  it("should offer nothing to submit for empty input", () => {
    const state = deriveBulkInputState("   ", "Screen-Role");
    expect(state.canSubmit).toBe(false);
    expect(state.errors).toEqual([]);
    expect(state.accounts).toEqual([]);
  });

  it("should carry the parse errors through and refuse submission", () => {
    const state = deriveBulkInputState("222222222222 oops", "Screen-Role");
    expect(state.canSubmit).toBe(false);
    expect(state.errors.join("\n")).toContain("oops");
  });

  it("should resolve the single role name for a plain ID paste", () => {
    const state = deriveBulkInputState("222222222222\n333333333333", "Screen-Role");
    expect(state.canSubmit).toBe(true);
    expect(state.accounts.length).toBe(2);
    expect(state.canSubmit && state.roleName).toBe("Screen-Role");
    expect(state.canSubmit && state.pastedDefaults).toBeUndefined();
  });

  it("should keep the pasted defaults for the request", () => {
    const state = deriveBulkInputState(
      JSON.stringify({
        defaults: { region: "us-east-1", competitorRoleName: "Pasted-Role" },
        accounts: [{ awsAccountId: "222222222222" }],
      }),
      "Screen-Role",
    );
    expect(state.canSubmit).toBe(true);
    if (!state.canSubmit) return;
    expect(state.pastedDefaults).toEqual({
      region: "us-east-1",
      competitorRoleName: "Pasted-Role",
    });
    expect(state.roleName).toBe("Pasted-Role");
  });

  it("should refuse a paste whose rows resolve to different roles", () => {
    const state = deriveBulkInputState(
      JSON.stringify({
        defaults: { competitorRoleName: "Default-Role" },
        accounts: [
          { awsAccountId: "222222222222" },
          { awsAccountId: "333333333333", competitorRoleName: "Other-Role" },
        ],
      }),
      "Screen-Role",
    );
    expect(state.canSubmit).toBe(false);
    expect(state.errors.join("\n")).toContain("IAM Role 名が行ごとに異なります");
    // The rows still parsed; only submission is blocked.
    expect(state.accounts.length).toBe(2);
  });
});
