import { describe, expect, it } from "vitest";
import { extractBearerToken } from "../../lib/problem-deploy/handlers/participant-handler/auth";

const VALID = "AbCdEfGhIjKlMnOpQrStUvWx"; // 24 文字 base64url

describe("extractBearerToken", () => {
  it("Bearer プレフィックスから 24 文字 base64url を抜くべき", () => {
    expect(extractBearerToken(`Bearer ${VALID}`)).toBe(VALID);
  });

  it("プレフィックス大文字小文字に寛容であるべき", () => {
    expect(extractBearerToken(`bearer ${VALID}`)).toBe(VALID);
    expect(extractBearerToken(`BEARER ${VALID}`)).toBe(VALID);
  });

  it("undefined ヘッダは undefined", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("Bearer プレフィックスが無いと undefined", () => {
    expect(extractBearerToken(VALID)).toBeUndefined();
    expect(extractBearerToken(`Token ${VALID}`)).toBeUndefined();
  });

  it("空 / 空白のみ ヘッダは undefined", () => {
    expect(extractBearerToken("")).toBeUndefined();
    expect(extractBearerToken("   ")).toBeUndefined();
  });

  it("23 / 25 文字のキーは形式不一致で undefined", () => {
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 23)}`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID}A`)).toBeUndefined();
  });

  it("base64url 外文字 (= や +, /, スペース) は undefined", () => {
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 23)}=`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 23)}+`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 23)}/`)).toBeUndefined();
  });

  it("ハイフン / アンダースコアは base64url なので OK", () => {
    const withDashes = "AbCdEfGhIjKlMnOpQ_StU-Wx";
    expect(extractBearerToken(`Bearer ${withDashes}`)).toBe(withDashes);
  });
});
