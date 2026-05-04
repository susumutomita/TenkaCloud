const { pickAssignableAppRole, resolveAppRole } = require("./invitation");

const NULL_APP_ROLE_ID = "00000000-0000-0000-0000-000000000000";

describe("invitation appRole 解決", () => {
  describe("pickAssignableAppRole", () => {
    describe("msiam_access value を持つ role があるとき", () => {
      it("最優先で返すべき (value matchで先勝ち)", () => {
        const roles = [
          { id: "role-a", value: "Other", isEnabled: true, allowedMemberTypes: ["User"] },
          { id: "role-b", value: "msiam_access", isEnabled: true, allowedMemberTypes: ["User"] },
        ];
        expect(pickAssignableAppRole(roles).id).toBe("role-b");
      });
    });

    describe("msiam_access が value ではなく displayName にあるとき", () => {
      it("displayName match で返すべき", () => {
        const roles = [
          { id: "role-a", value: "Reader", isEnabled: true, allowedMemberTypes: ["User"] },
          { id: "role-b", value: "Custom", displayName: "msiam_access", isEnabled: true },
        ];
        expect(pickAssignableAppRole(roles).id).toBe("role-b");
      });
    });

    describe("msiam_access が無く User 許可 + enabled な role があるとき", () => {
      it("最初に該当した role を fallback として返すべき", () => {
        const roles = [
          { id: "role-a", value: "Disabled", isEnabled: false, allowedMemberTypes: ["User"] },
          { id: "role-b", value: "AppOnly", isEnabled: true, allowedMemberTypes: ["Application"] },
          { id: "role-c", value: "Reader", isEnabled: true, allowedMemberTypes: ["User"] },
          { id: "role-d", value: "Writer", isEnabled: true, allowedMemberTypes: ["User"] },
        ];
        expect(pickAssignableAppRole(roles).id).toBe("role-c");
      });
    });

    describe("どの role も使えない (全 disabled / App-only) とき", () => {
      it("NULL_APP_ROLE_ID で fallback するべき", () => {
        const roles = [
          { id: "role-a", value: "Disabled", isEnabled: false, allowedMemberTypes: ["User"] },
          { id: "role-b", value: "AppOnly", isEnabled: true, allowedMemberTypes: ["Application"] },
        ];
        expect(pickAssignableAppRole(roles).id).toBe(NULL_APP_ROLE_ID);
      });
    });

    describe("appRoles が空配列のとき", () => {
      it("NULL_APP_ROLE_ID を返すべき", () => {
        expect(pickAssignableAppRole([]).id).toBe(NULL_APP_ROLE_ID);
      });
    });
  });

  describe("resolveAppRole (public API wrapper)", () => {
    describe("enterpriseApp.appRoles が undefined のとき", () => {
      it("空配列扱いで NULL_APP_ROLE_ID を返すべき", () => {
        expect(resolveAppRole({}).id).toBe(NULL_APP_ROLE_ID);
      });
    });

    describe("enterpriseApp.appRoles に msiam_access があるとき", () => {
      it("該当 role を返すべき (pickAssignableAppRole の挙動と一致)", () => {
        const enterpriseApp = {
          appRoles: [
            { id: "role-other", value: "Other", isEnabled: true, allowedMemberTypes: ["User"] },
            {
              id: "role-msiam",
              value: "msiam_access",
              isEnabled: true,
              allowedMemberTypes: ["User"],
            },
          ],
        };
        expect(resolveAppRole(enterpriseApp).id).toBe("role-msiam");
      });
    });
  });
});
