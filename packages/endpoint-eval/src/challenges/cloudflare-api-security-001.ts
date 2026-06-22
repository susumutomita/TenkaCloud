import type { ChallengeDefinition } from "../challenge.js";
import type { Probe } from "../probe.js";
import { seededValue } from "../run-values.js";
import { CLOUDFLARE_WORKERS_POLICY } from "../target-guard.js";

/**
 * Issue #1973: 最初の問題 "API Security Deploy Challenge"。
 *
 * 参加者は脆弱なプロフィール API を Cloudflare Worker として公開し、 外部評価を通すために
 * 段階的に修正する。 **このファイルは隠しテスト (採点条件) なので server-side にのみ置く** —
 * 参加者リポジトリ (`sample-challenges/cloudflare-api-security-001/`) には出さない。
 *
 * 公開契約 (= 参加者が知ってよい仕様。 `sample-challenges/.../README.md` と一致):
 *   固定 fixture ユーザー:
 *     alice: id `u_alice`, token `tok_alice`
 *     bob  : id `u_bob`,   token `tok_bob`
 *   GET   /healthz                         → 200 {"status":"ok"}
 *   GET   /profiles/:id  (Bearer token)    → 自分=200 {id,name,email} / 他人=403 / 無効=401
 *   PATCH /profiles/:id  (Bearer + JSON)   → 検証 OK かつ自分=200 / 不正 body=400 / 他人=403
 *   未知パス                                → 404 (スタックトレース等を漏らさない)
 *
 * 隠している部分: 具体的なテスト入力列・期待ステータス・本文判定・クリアコード鍵。
 * テスト入力は run ごとに変える ({@link ChallengeDefinition.makeRunValues})。
 */

const ALICE = { id: "u_alice", token: "tok_alice", email: "alice@example.com" };
const BOB = { id: "u_bob", token: "tok_bob" };

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const stage0: Probe[] = [
  {
    id: "healthz-200",
    request: { method: "GET", path: "/healthz" },
    expect: { status: 200, bodyIncludes: ["ok"] },
    description: "GET /healthz が 200 で疎通すること",
  },
  {
    id: "own-profile-200",
    request: { method: "GET", path: `/profiles/${ALICE.id}`, headers: bearer(ALICE.token) },
    expect: { status: 200, bodyIncludes: [ALICE.email] },
    description: "自分のプロフィールを 200 で取得できること",
  },
];

const stage1: Probe[] = [
  {
    id: "reject-non-json",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: "not json at all",
    },
    expect: { status: 400 },
    description: "不正な JSON 本文を 400 で拒否すること",
  },
  {
    id: "reject-wrong-type",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: '{"name":12345}',
    },
    expect: { status: 400 },
    description: "name の型違反 (数値) を 400 で拒否すること",
  },
  {
    id: "reject-empty",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: '{"name":""}',
    },
    expect: { status: 400 },
    description: "空の name を 400 で拒否すること",
  },
  {
    id: "reject-too-long",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: '{"name":"{longName}"}',
    },
    expect: { status: 400 },
    description: "過長な name を 400 で拒否すること",
  },
  {
    id: "reject-unexpected-method",
    request: { method: "DELETE", path: `/profiles/${ALICE.id}`, headers: bearer(ALICE.token) },
    expect: { status: [404, 405] },
    description: "想定外メソッドを 404/405 で拒否すること",
  },
];

const stage2: Probe[] = [
  {
    id: "idor-read",
    request: { method: "GET", path: `/profiles/${BOB.id}`, headers: bearer(ALICE.token) },
    expect: { status: 403, bodyExcludes: [BOB.token] },
    description: "他ユーザーのプロフィールを読めないこと (IDOR)",
  },
  {
    id: "idor-update",
    request: {
      method: "PATCH",
      path: `/profiles/${BOB.id}`,
      headers: bearer(ALICE.token),
      body: '{"name":"{newName}"}',
    },
    expect: { status: 403 },
    description: "他ユーザーのプロフィールを更新できないこと (IDOR)",
  },
  {
    id: "missing-auth-401",
    request: { method: "GET", path: `/profiles/${ALICE.id}` },
    expect: { status: 401 },
    description: "認証なしアクセスを 401 で拒否すること",
  },
  {
    id: "invalid-token-401",
    request: { method: "GET", path: `/profiles/${ALICE.id}`, headers: bearer("tok_forged") },
    expect: { status: 401 },
    description: "無効トークンを 401 で拒否すること",
  },
];

const stage3: Probe[] = [
  {
    id: "unknown-path-404",
    request: { method: "GET", path: "/internal/debug/{badId}" },
    expect: {
      status: [401, 404],
      bodyExcludes: ["stack", "Stack", "TODO", "at Object.", "node_modules"],
    },
    description: "未知/内部パスでスタックトレースや内部情報を漏らさないこと",
  },
  {
    id: "no-secret-leak",
    request: { method: "GET", path: `/profiles/${ALICE.id}`, headers: bearer(ALICE.token) },
    expect: { status: 200, bodyExcludes: [ALICE.token, BOB.token] },
    description: "レスポンスに認証トークン等の秘密値を含めないこと",
  },
  {
    id: "malformed-id-no-500",
    request: {
      method: "GET",
      path: "/profiles/%27%20OR%20%271%27=%271",
      headers: bearer(ALICE.token),
    },
    expect: { status: [400, 403, 404], bodyExcludes: ["stack", "Error:", "undefined"] },
    description: "異常な id 入力で 500/例外を露出しないこと",
  },
];

const stage4: Probe[] = [
  {
    id: "happy-path-update",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: '{"name":"{newName}"}',
    },
    expect: { status: 200, bodyIncludes: ["{newName}"] },
    description: "正常な更新が 200 で反映されること",
  },
  {
    id: "regression-healthz",
    request: { method: "GET", path: "/healthz" },
    expect: { status: 200, bodyIncludes: ["ok"] },
    description: "回帰: /healthz が引き続き 200 であること",
  },
  {
    id: "regression-idor",
    request: { method: "GET", path: `/profiles/${BOB.id}`, headers: bearer(ALICE.token) },
    expect: { status: 403 },
    description: "回帰: IDOR 対策が維持されていること",
  },
  {
    id: "regression-bad-json",
    request: {
      method: "PATCH",
      path: `/profiles/${ALICE.id}`,
      headers: bearer(ALICE.token),
      body: "broken",
    },
    expect: { status: 400 },
    description: "回帰: 入力検証が維持されていること",
  },
];

export const cloudflareApiSecurity001: ChallengeDefinition = {
  id: "cloudflare-api-security-001",
  title: "API Security Deploy Challenge",
  targetPolicy: CLOUDFLARE_WORKERS_POLICY,
  makeRunValues: (seed) => ({
    newName: `Name-${seededValue(seed, "name", 8)}`,
    longName: "x".repeat(60),
    badId: seededValue(seed, "badId", 10),
  }),
  stages: [
    { id: "0-deploy", title: "Deploy & reachability", probes: stage0 },
    { id: "1-input-validation", title: "Input validation", probes: stage1 },
    { id: "2-authorization", title: "Authorization (IDOR)", probes: stage2 },
    { id: "3-info-disclosure", title: "Information disclosure", probes: stage3 },
    { id: "4-final", title: "Final regression", probes: stage4 },
  ],
};
