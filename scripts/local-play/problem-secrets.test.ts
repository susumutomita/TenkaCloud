import { describe, expect, it } from "bun:test";
import { deriveSecretEnv, loadOrCreateMasterSecret } from "./problem-secrets";

/**
 * Issue #2975 — an evicted container must come back with the same answers.
 *
 * Local play caps concurrent problems and evicts the least-recently-used one. Under the
 * old per-start random draw, the evicted problem restarted with a fresh `FLAG_SEED`, so
 * every value the participant had derived stopped being the answer. Measured in one
 * session: four wrong submissions on `stackstack-secrets`, two on
 * `stackstack-observability`, a scored penalty on `hollow-invite`, and
 * `stackstack-defend`'s sixty-second final checkpoint failing five times running.
 *
 * The four properties below are the whole contract, and each is a distinct way to get
 * this wrong: stable across restarts, distinct across problems, distinct across
 * deployments, and stable across process restarts (the stop button suggests stopping,
 * so "same process" is not a safe assumption to build fairness on).
 */

function memoryIo() {
  const files = new Map<string, string>();
  let draws = 0;
  return {
    files,
    drawCount: () => draws,
    io: {
      exists: (path: string) => files.has(path),
      read: (path: string) => files.get(path) as string,
      write: (path: string, content: string) => void files.set(path, content),
      randomHex: () => {
        draws += 1;
        return `${draws}`.padStart(64, "0");
      },
    },
  };
}

describe("problem secrets (Issue #2975)", () => {
  it("は同じ問題を再起動しても同じ evidence を出す", () => {
    // 退去 → 再起動が採点から見えなくなる、というのがこの修正の全部。
    const master = "a".repeat(64);
    const first = deriveSecretEnv(master, "stackstack-secrets", ["FLAG_SEED"]);
    const second = deriveSecretEnv(master, "stackstack-secrets", ["FLAG_SEED"]);
    expect(second).toEqual(first);
    expect(first.FLAG_SEED).toMatch(/^[0-9a-f]{64}$/);
  });

  it("は問題ごとに違う evidence を出す", () => {
    const master = "a".repeat(64);
    const one = deriveSecretEnv(master, "stackstack-secrets", ["FLAG_SEED"]);
    const other = deriveSecretEnv(master, "stackstack-observability", ["FLAG_SEED"]);
    expect(other.FLAG_SEED).not.toBe(one.FLAG_SEED);
  });

  it("は同じ問題でも env 名ごとに違う値を出す", () => {
    const env = deriveSecretEnv("a".repeat(64), "p", ["FLAG_SEED", "ADMIN_TOKEN"]);
    expect(env.FLAG_SEED).not.toBe(env.ADMIN_TOKEN);
  });

  it("は問題 id と env 名の境界を取り違えない", () => {
    // NUL 区切りが無いと ("ab","c") と ("a","bc") が同じ入力になる。
    const master = "a".repeat(64);
    expect(deriveSecretEnv(master, "ab", ["c"]).c).not.toBe(
      deriveSecretEnv(master, "a", ["bc"]).bc,
    );
  });

  it("は deployment が違えば違う evidence を出す", () => {
    // 「他人の run の答えが持ち越せない」という元の設計意図は残す。
    const one = deriveSecretEnv("a".repeat(64), "p", ["FLAG_SEED"]);
    const other = deriveSecretEnv("b".repeat(64), "p", ["FLAG_SEED"]);
    expect(other.FLAG_SEED).not.toBe(one.FLAG_SEED);
  });

  it("は master を deployment ごとに 1 度だけ作り、以後は読み直す", () => {
    // process 再起動をまたいでも同じ答えになる。停止ボタン自身が停止を勧めているので、
    // 「同じ process の中だけ安定」では参加者を守れない。
    const { io, drawCount } = memoryIo();
    const first = loadOrCreateMasterSecret("/deployment", io);
    const second = loadOrCreateMasterSecret("/deployment", io);
    expect(second).toBe(first);
    expect(drawCount()).toBe(1);
  });

  it("は壊れた master を読まずに作り直す", () => {
    // 切り詰められた鍵から導出すると、deployment 中の全問題の答えが黙って変わる。
    // それはこの file が消そうとしている失敗そのもの。
    const { io, files, drawCount } = memoryIo();
    files.set("/deployment/problem-secrets.key", "not-a-key\n");
    const created = loadOrCreateMasterSecret("/deployment", io);
    expect(created).toMatch(/^[0-9a-f]{64}$/);
    expect(drawCount()).toBe(1);
    expect(loadOrCreateMasterSecret("/deployment", io)).toBe(created);
  });

  it("は env 名が無ければ空を返す", () => {
    expect(deriveSecretEnv("a".repeat(64), "p", [])).toEqual({});
    expect(deriveSecretEnv("a".repeat(64), "p")).toEqual({});
  });
});
