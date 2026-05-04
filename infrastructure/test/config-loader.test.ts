import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPlaceholders, loadConfig } from "../lib/utils/config-loader";

/**
 * config-loader (既存ユーティリティ) の振る舞い。
 *
 *   - expandPlaceholders: `${VAR:-default}` 構文 (jpki-api 互換) を env 値で置換
 *   - loadConfig        : `environments/<env>/config.json` を読んで Config を返す facade
 *
 * 設計の意図:
 *   - tolerant=true (loadConfig の default) で、未定義 + default 無しの placeholder は
 *     literal `${VAR}` のまま残す。bin 側は dynamoDbConfig しか consume しないので、
 *     他セクション (`${TenkaCloud_ADMIN_EMAIL}` 等) の env 未設定で全体が落ちるのを避ける
 *
 * 各 case で一時ディレクトリを切って、そこに ダミーの environments/<env>/config.json を
 * 置いて検証する (caller が bin の場合 __dirname を渡してくる)。
 */

/**
 * test 用に `${VAR:-default}` placeholder を組み立てる。
 * `"${VAR:-x}"` をそのまま書くと biome の noTemplateCurlyInString 警告が出る (false positive)
 * ので template literal で組み立てる。
 */
const ph = (name: string, def?: string) => `\${${name}${def === undefined ? "" : `:-${def}`}}`;

describe("expandPlaceholders", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("env が定義されているとき", () => {
    it("env 値で placeholder を置換するべき", () => {
      process.env.MY_VAR = "hello";
      expect(expandPlaceholders(`value=${ph("MY_VAR")}`, process.env)).toBe("value=hello");
    });

    it("default 値があっても env 値を優先するべき", () => {
      process.env.MY_VAR = "envValue";
      expect(expandPlaceholders(`v=${ph("MY_VAR", "fallback")}`, process.env)).toBe("v=envValue");
    });
  });

  describe("env が未定義 + default 値があるとき", () => {
    it("default 値で placeholder を置換するべき", () => {
      delete process.env.MY_VAR;
      expect(expandPlaceholders(`v=${ph("MY_VAR", "fallback")}`, process.env)).toBe("v=fallback");
    });
  });

  describe("env が未定義 + default 値も無いとき", () => {
    it("default では throw するべき", () => {
      delete process.env.MY_VAR;
      expect(() => expandPlaceholders(`v=${ph("MY_VAR")}`, process.env)).toThrowError(/MY_VAR/);
    });

    it("tolerant=true なら literal placeholder を残すべき (consumer が読まない field の保護)", () => {
      delete process.env.MY_VAR;
      expect(expandPlaceholders(`v=${ph("MY_VAR")}`, process.env, { tolerant: true })).toBe(
        `v=${ph("MY_VAR")}`,
      );
    });
  });
});

describe("loadConfig (環境別 config.json + .env)", () => {
  let tmpRoot: string;
  let baseDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "load-config-"));
    // baseDir = caller の __dirname 相当。loader 内で `path.resolve(baseDir, "../environments/<env>/...")`
    // を叩くので、tmpRoot/bin と tmpRoot/environments/<env>/config.json の構造を作る。
    baseDir = path.join(tmpRoot, "bin");
    fs.mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeConfig(envName: string, content: object) {
    const dir = path.join(tmpRoot, "environments", envName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(content, null, 2));
  }

  describe("config.json が存在しないとき", () => {
    it("undefined を返すべき (caller が default にフォールバック)", () => {
      expect(loadConfig("development", baseDir)).toBeUndefined();
    });
  });

  describe("dynamoDbConfig セクションを持つ config.json があるとき", () => {
    it("literal 値をそのまま返すべき", () => {
      writeConfig("development", {
        dynamoDbConfig: { billingMode: "PROVISIONED", readCapacity: 5, writeCapacity: 7 },
      });
      const config = loadConfig("development", baseDir);
      expect(config?.dynamoDbConfig).toEqual({
        billingMode: "PROVISIONED",
        readCapacity: 5,
        writeCapacity: 7,
      });
    });

    it("placeholder を env で展開して返すべき", () => {
      writeConfig("development", {
        dynamoDbConfig: {
          billingMode: ph("DYNAMODB_BILLING_MODE", "PROVISIONED"),
          readCapacity: ph("DYNAMODB_READ_CAPACITY", "1"),
          writeCapacity: ph("DYNAMODB_WRITE_CAPACITY", "1"),
        },
      });
      process.env.DYNAMODB_BILLING_MODE = "PAY_PER_REQUEST";
      process.env.DYNAMODB_READ_CAPACITY = "10";
      process.env.DYNAMODB_WRITE_CAPACITY = "20";

      const config = loadConfig("development", baseDir);
      expect(config?.dynamoDbConfig).toEqual({
        billingMode: "PAY_PER_REQUEST",
        readCapacity: "10",
        writeCapacity: "20",
      });
    });

    it("env が未設定なら placeholder の default 値を使うべき", () => {
      writeConfig("development", {
        dynamoDbConfig: {
          billingMode: ph("DYNAMODB_BILLING_MODE", "PROVISIONED"),
          readCapacity: ph("DYNAMODB_READ_CAPACITY", "1"),
          writeCapacity: ph("DYNAMODB_WRITE_CAPACITY", "1"),
        },
      });
      delete process.env.DYNAMODB_BILLING_MODE;
      delete process.env.DYNAMODB_READ_CAPACITY;
      delete process.env.DYNAMODB_WRITE_CAPACITY;

      const config = loadConfig("development", baseDir);
      expect(config?.dynamoDbConfig).toEqual({
        billingMode: "PROVISIONED",
        readCapacity: "1",
        writeCapacity: "1",
      });
    });
  });

  describe("dynamoDbConfig 以外のセクションに env 未設定の placeholder があるとき", () => {
    it("tolerant モードで literal placeholder を残し、dynamoDbConfig は通常通り使えるべき", () => {
      writeConfig("development", {
        controlPlaneConfig: {
          systemAdminEmail: ph("TenkaCloud_ADMIN_EMAIL"),
        },
        dynamoDbConfig: { billingMode: "PROVISIONED", readCapacity: 1, writeCapacity: 1 },
      });
      delete process.env.TenkaCloud_ADMIN_EMAIL;

      const config = loadConfig("development", baseDir);
      expect(config?.dynamoDbConfig).toEqual({
        billingMode: "PROVISIONED",
        readCapacity: 1,
        writeCapacity: 1,
      });
      expect(config?.controlPlaneConfig?.systemAdminEmail).toBe(ph("TenkaCloud_ADMIN_EMAIL"));
    });
  });
});
