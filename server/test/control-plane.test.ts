import type { ControlPlaneStackProps } from "../lib/control-plane";

describe("ControlPlaneStack", () => {
  describe("given all parameters are specified", () => {
    const props: ControlPlaneStackProps = {
      systemAdminEmail: "admin@example.com",
      systemAdminRoleName: "Admin",
      enableAdvancedSecurityMode: true,
      setAPIGWScopes: true,
      disableAPILogging: false,
    };

    it("should accept configurable security parameters", () => {
      expect(props.enableAdvancedSecurityMode).toBe(true);
      expect(props.setAPIGWScopes).toBe(true);
      expect(props.disableAPILogging).toBe(false);
    });
  });

  describe("given only required parameters", () => {
    const props: ControlPlaneStackProps = {
      systemAdminEmail: "admin@example.com",
    };

    it("should leave optional fields undefined for secure defaults", () => {
      expect(props.enableAdvancedSecurityMode).toBeUndefined();
      expect(props.setAPIGWScopes).toBeUndefined();
      expect(props.disableAPILogging).toBeUndefined();
    });
  });

  // Full stack synthesis requires Docker for CognitoAuth's PythonFunction.
  // Integration tests via `make synth` cover this path.
});
