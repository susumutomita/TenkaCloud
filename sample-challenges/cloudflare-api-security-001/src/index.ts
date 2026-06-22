/**
 * API Security Deploy Challenge — スターター Worker (Issue #1973)。
 *
 * これは **わざと脆弱な** プロフィール API です。 そのままデプロイすると Stage 0 (疎通) は
 * 通りますが、 Stage 1〜4 は通りません。 評価が返す失敗理由を手がかりに、 入力検証 → 認可
 * (IDOR 対策) → 情報漏えい対策 を段階的に実装してください。
 *
 * 採点条件・隠しテスト・回答コードはこのリポジトリには含まれません (= TenkaCloud 側だけが保持)。
 * デプロイ:  bunx wrangler deploy --temporary
 * 評価:     README.md の「評価する」を参照。
 */

interface Profile {
  id: string;
  name: string;
  email: string;
}

// 固定 fixture ユーザー (公開契約)。
const users: Record<string, Profile> = {
  u_alice: { id: "u_alice", name: "Alice", email: "alice@example.com" },
  u_bob: { id: "u_bob", name: "Bob", email: "bob@example.com" },
};
const tokenToUser: Record<string, string> = { tok_alice: "u_alice", tok_bob: "u_bob" };

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    const callerId = token ? tokenToUser[token] : undefined;

    if (url.pathname === "/healthz") {
      return json({ status: "ok" }, 200);
    }

    const match = url.pathname.match(/^\/profiles\/([^/]+)$/);
    if (match) {
      const targetId = decodeURIComponent(match[1]);

      // TODO(Stage 2): 認証必須にする。 今は token が無くても通ってしまう。
      // TODO(Stage 2): callerId と targetId が違うとき 403 を返す (IDOR 対策)。

      if (req.method === "GET") {
        const profile = users[targetId];
        if (!profile) return json({ error: "not found" }, 404);
        // NOTE: callerId を一切見ていない = 他人のプロフィールも読めてしまう。
        return json(profile, 200);
      }

      if (req.method === "PATCH") {
        // TODO(Stage 1): JSON / 型 / 長さ / 空値 / Content-Type を検証する。
        const raw = await req.text();
        const parsed = JSON.parse(raw) as { name?: unknown };
        const profile = users[targetId];
        profile.name = String(parsed.name);
        return json(profile, 200);
      }

      return json({ error: "method not allowed" }, 405);
    }

    // TODO(Stage 3): 未知パスや異常入力でスタックトレース等を漏らさない。
    // 今は例外をそのまま投げており、内部情報が露出する。
    throw new Error(`Unhandled route: ${url.pathname} (caller=${callerId})`);
  },
};
