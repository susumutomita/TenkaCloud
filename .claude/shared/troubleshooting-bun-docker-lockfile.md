
# Bun + Docker: lockfile エラーのトラブルシューティング

## 問題

Docker ビルド時に以下のエラーが発生：

```
error: lockfile had changes, but lockfile is frozen
note: try re-running without --frozen-lockfile and commit the updated lockfile
```

## 原因

ローカル環境の Bun バージョン（例: 1.2.20）と Docker イメージの Bun バージョン（例: 1.3.3）が異なるため、lockfile の形式に互換性がない。

## 解決方法

### 1. Docker イメージのバージョンを明示的に指定

```dockerfile
# ❌ NG: latest タグを使用
FROM oven/bun:1

# ✅ OK: ローカル環境と同じバージョンを明示
FROM oven/bun:1.2.20
```

### 2. ローカル環境のバージョン確認

```bash
bun --version
# 出力例: 1.2.20
```

### 3. Dockerfile の更新

```dockerfile
FROM oven/bun:1.2.20

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
```

### 4. 再ビルド

```bash
docker compose build --no-cache
docker compose up
```

## 予防策

- **バージョンを固定**: Dockerfile では常に特定のバージョンタグを使用（`:latest` や `:1` は避ける）
- **.tool-versions または .nvmrc の活用**: Bun や Node.js のバージョンをリポジトリルートに記載
- **CI でバージョンチェック**: ローカル環境と Docker 環境のバージョンが一致しているか自動検証

## 関連リソース

- [Bun Dockerfile Examples](https://bun.sh/docs/install/docker)
- [Docker Multi-stage Builds](https://docs.docker.com/build/building/multi-stage/)
### SHARED_KNOWLEDGE_END
### SHARED_KNOWLEDGE_START

# NextAuth + Keycloak: ログアウト時の "Invalid parameter: id_token_hint" エラー

## 問題

Keycloak からログアウトしようとすると、以下のエラーが表示される：

```
We are sorry...
Invalid parameter: id_token_hint
```

## 原因

NextAuth の `signOut()` を実行すると、セッションがクリアされる。その後、セッションから `idToken` を取得しようとすると `undefined` になり、Keycloak のログアウトエンドポイントに `id_token_hint` パラメータを渡せない。

## 解決方法

### ❌ NG: signOut後にidTokenを取得

```typescript
export async function logout() {
  const currentSession = await auth();
  
  await signOut({ redirect: false }); // ここでセッションがクリア
  
  // ❌ currentSession.idToken は既に undefined
  if (currentSession?.idToken && process.env.AUTH_KEYCLOAK_ISSUER) {
    const logoutUrl = `${process.env.AUTH_KEYCLOAK_ISSUER}/protocol/openid-connect/logout?id_token_hint=${currentSession.idToken}`;
    redirect(logoutUrl);
  }
  
  redirect("/");
}
```

### ✅ OK: signOut前にidTokenを保存

```typescript
export async function logout() {
  const currentSession = await auth();
  
  // ✅ signOut実行前にidTokenを変数に保存
  const idToken = currentSession?.idToken;
  const keycloakIssuer = process.env.AUTH_KEYCLOAK_ISSUER;
  
  await signOut({ redirect: false });
  
  // ✅ 保存したidTokenを使用
  if (idToken && keycloakIssuer) {
    const redirectUri = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const encodedRedirectUri = encodeURIComponent(redirectUri);
    const logoutUrl = `${keycloakIssuer}/protocol/openid-connect/logout?id_token_hint=${idToken}&post_logout_redirect_uri=${encodedRedirectUri}`;
    redirect(logoutUrl);
  }
  
  redirect("/");
}
```

## ポイント

1. **セッションデータの事前保存**: `signOut()` を実行する前に、必要なセッションデータ（`idToken` など）を変数に保存
2. **Keycloakログアウトパラメータ**:
   - `id_token_hint`: ログアウトするユーザーを識別するための ID トークン（必須）
   - `post_logout_redirect_uri`: ログアウト後のリダイレクト先（任意）

## 関連リソース

- [NextAuth.js: Server-side signOut](https://next-auth.js.org/getting-started/client#signout)
- [Keycloak: Logout Endpoint](https://www.keycloak.org/docs/latest/securing_apps/index.html#logout)
