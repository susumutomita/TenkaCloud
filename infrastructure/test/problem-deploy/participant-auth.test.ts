import { describe, expect, it } from "vitest";
import { extractBearerToken } from "../../lib/problem-deploy/handlers/participant-handler/auth";

// generateTeamLoginKey() = crypto.randomBytes(32).toString("base64url") → 43 文字
const VALID = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ"; // 43 文字 base64url

describe("extractBearerToken", () => {
  it("should extract a 43-char base64url token from the Bearer prefix", () => {
    expect(VALID).toHaveLength(43);
    expect(extractBearerToken(`Bearer ${VALID}`)).toBe(VALID);
  });

  it("should be tolerant of prefix case", () => {
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

  it("42 / 44 文字のキーは形式不一致で undefined", () => {
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 42)}`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID}A`)).toBeUndefined();
  });

  it("旧仕様 (24 文字) のキーは形式不一致で undefined", () => {
    // randomBytes(18) ベースに戻る regression を防ぐ。
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 24)}`)).toBeUndefined();
  });

  it("base64url 外文字 (= や +, /, スペース) は undefined", () => {
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 42)}=`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 42)}+`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${VALID.slice(0, 42)}/`)).toBeUndefined();
  });

  it("ハイフン / アンダースコアは base64url なので OK", () => {
    const withDashes = "AbCdEfGhIjKlMnOpQ_StU-WxYzAbCdEfGhIjKlMnOpQ"; // 43 文字
    expect(withDashes).toHaveLength(43);
    expect(extractBearerToken(`Bearer ${withDashes}`)).toBe(withDashes);
  });
});
