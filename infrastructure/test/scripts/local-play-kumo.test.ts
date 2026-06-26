import { describe, expect, it } from "vitest";
import {
  assertLocalKumoEndpoint,
  buildLocalParameters,
  renderCloudFormationTemplate,
} from "../../../scripts/local-play/kumo";

describe("local-play Kumo helpers", () => {
  it("should reject non-loopback Kumo endpoints", () => {
    expect(() => assertLocalKumoEndpoint("https://kumo.example.com")).toThrow(
      "Refusing non-local Kumo endpoint",
    );
    expect(() => assertLocalKumoEndpoint("http://127.0.0.1:4566")).not.toThrow();
  });

  it("should replace random-password sentinels with the generated local secret", () => {
    expect(
      buildLocalParameters(
        "hello-world",
        { FlagSeed: "__RANDOM_PASSWORD__", StaticValue: "kept" },
        "generatedSeed123",
      ),
    ).toEqual({
      NamePrefix: "tc-hello-world-kumo",
      TenkaCloudAccountId: "000000000000",
      ExternalId: "tc-hello-world-kumo-external-id",
      FlagSeed: "generatedSeed123",
      StaticValue: "kept",
    });
  });

  it("should convert CloudFormation short tags into JSON intrinsics", () => {
    const rendered = JSON.parse(
      renderCloudFormationTemplate(`
Resources:
  Parameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub "/\${NamePrefix}/hello"
      Value: !Ref FlagSeed
Outputs:
  Arn:
    Value: !GetAtt Parameter.Arn
`),
    );
    const namePrefixExpression = `$${"{NamePrefix}"}`;

    expect(rendered.Resources.Parameter.Properties).toEqual({
      Name: { "Fn::Sub": `/${namePrefixExpression}/hello` },
      Value: { Ref: "FlagSeed" },
    });
    expect(rendered.Outputs.Arn.Value).toEqual({ "Fn::GetAtt": ["Parameter", "Arn"] });
  });

  it("should reject unsupported non-scalar intrinsic forms loudly", () => {
    expect(() =>
      renderCloudFormationTemplate(`
Resources:
  Parameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub ["/\${Prefix}/hello", { Prefix: "tc-local" }]
`),
    ).toThrow("!Sub must use scalar form in local play");
  });
});
