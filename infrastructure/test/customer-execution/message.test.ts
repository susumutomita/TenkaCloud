import { describe, expect, it } from "vitest";
import { parseIntentMessage } from "../../lib/customer-execution/handler/message";

function body(obj: unknown): string {
  return JSON.stringify(obj);
}

const TEMPLATE = "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n";
const TEMPLATE_B64 = Buffer.from(TEMPLATE, "utf8").toString("base64");

describe("parseIntentMessage", () => {
  it("should parse a valid message into token + template bytes", () => {
    const parsed = parseIntentMessage(
      body({ token: "jws.token.sig", templateBase64: TEMPLATE_B64 }),
    );
    expect(parsed.token).toBe("jws.token.sig");
    expect(new TextDecoder().decode(parsed.templateBytes)).toBe(TEMPLATE);
  });

  it("should reject non-JSON bodies", () => {
    expect(() => parseIntentMessage("not json")).toThrow(/not valid JSON/);
  });

  it("should reject a body missing the token", () => {
    expect(() => parseIntentMessage(body({ templateBase64: TEMPLATE_B64 }))).toThrow(
      /schema validation/,
    );
  });

  it("should reject unknown extra properties (strict)", () => {
    expect(() =>
      parseIntentMessage(body({ token: "t", templateBase64: TEMPLATE_B64, extra: 1 })),
    ).toThrow(/schema validation/);
  });

  it("should reject an invalid base64 template", () => {
    expect(() =>
      parseIntentMessage(body({ token: "t", templateBase64: "!!!not base64!!!" })),
    ).toThrow(/not valid base64/);
  });
});
