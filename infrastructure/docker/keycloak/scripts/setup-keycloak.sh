#!/bin/bash

# TenkaCloud Keycloak 自動セットアップスクリプト
# このスクリプトは Keycloak の Realm と Client を自動作成します

set -e

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin_password}"
REALM_NAME="tenkacloud"
CLIENT_ID="control-plane-ui"
REDIRECT_URI="http://localhost:3000/*"
WEB_ORIGINS="http://localhost:3000"

echo "🚀 TenkaCloud Keycloak セットアップを開始します..."
echo ""

# Keycloak が起動するまで待機
echo "⏳ Keycloak の起動を待っています..."
max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
  if curl -s -f "${KEYCLOAK_URL}/health/ready" > /dev/null 2>&1; then
    echo "✅ Keycloak が起動しました"
    break
  fi
  attempt=$((attempt + 1))
  echo "   試行 ${attempt}/${max_attempts}..."
  sleep 2
done

if [ $attempt -eq $max_attempts ]; then
  echo "❌ Keycloak の起動に失敗しました"
  exit 1
fi

echo ""

# 管理者トークンを取得
echo "🔑 管理者トークンを取得しています..."
TOKEN_RESPONSE=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASSWORD}" \
  -d "grant_type=password" \
  -d "client_id=admin-cli")

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*' | sed 's/"access_token":"//')

if [ -z "$ACCESS_TOKEN" ]; then
  echo "❌ 管理者トークンの取得に失敗しました"
  echo "レスポンス: $TOKEN_RESPONSE"
  exit 1
fi

echo "✅ 管理者トークン取得成功"
echo ""

# Realm が既に存在するか確認
echo "🔍 Realm '${REALM_NAME}' の存在を確認しています..."
REALM_EXISTS=$(curl -s -o /dev/null -w "%{http_code}" "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

if [ "$REALM_EXISTS" = "200" ]; then
  echo "⚠️  Realm '${REALM_NAME}' は既に存在します"
else
  # Realm を作成
  echo "📝 Realm '${REALM_NAME}' を作成しています..."
  curl -s -X POST "${KEYCLOAK_URL}/admin/realms" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"realm\": \"${REALM_NAME}\",
      \"enabled\": true,
      \"displayName\": \"TenkaCloud\",
      \"loginTheme\": \"keycloak\",
      \"sslRequired\": \"none\"
    }" > /dev/null

  echo "✅ Realm '${REALM_NAME}' を作成しました"
fi

echo ""

# Client が既に存在するか確認
echo "🔍 Client '${CLIENT_ID}' の存在を確認しています..."
CLIENT_UUID=$(curl -s "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients?clientId=${CLIENT_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | grep -o '"id":"[^"]*' | head -1 | sed 's/"id":"//')

if [ -n "$CLIENT_UUID" ]; then
  echo "⚠️  Client '${CLIENT_ID}' は既に存在します (ID: ${CLIENT_UUID})"
else
  # Client を作成
  echo "📝 Client '${CLIENT_ID}' を作成しています..."
  curl -s -X POST "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"clientId\": \"${CLIENT_ID}\",
      \"enabled\": true,
      \"protocol\": \"openid-connect\",
      \"publicClient\": false,
      \"clientAuthenticatorType\": \"client-secret\",
      \"standardFlowEnabled\": true,
      \"directAccessGrantsEnabled\": true,
      \"redirectUris\": [\"${REDIRECT_URI}\"],
      \"webOrigins\": [\"${WEB_ORIGINS}\"],
      \"attributes\": {
        \"post.logout.redirect.uris\": \"${REDIRECT_URI}\"
      }
    }" > /dev/null

  # Client UUID を再取得
  CLIENT_UUID=$(curl -s "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients?clientId=${CLIENT_ID}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" | grep -o '"id":"[^"]*' | head -1 | sed 's/"id":"//')

  echo "✅ Client '${CLIENT_ID}' を作成しました (ID: ${CLIENT_UUID})"
fi

echo ""

# Client Secret を取得
echo "🔐 Client Secret を取得しています..."
CLIENT_SECRET=$(curl -s "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients/${CLIENT_UUID}/client-secret" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | grep -o '"value":"[^"]*' | sed 's/"value":"//')

if [ -z "$CLIENT_SECRET" ]; then
  echo "❌ Client Secret の取得に失敗しました"
  exit 1
fi

echo "✅ Client Secret 取得成功"
echo ""

# デフォルトユーザーを作成
echo "👤 デフォルトユーザー 'user' を作成しています..."
USER_ID=$(curl -s "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/users?username=user" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | grep -o '"id":"[^"]*' | head -1 | sed 's/"id":"//')

if [ -n "$USER_ID" ]; then
  echo "⚠️  ユーザー 'user' は既に存在します (ID: ${USER_ID})"
else
  # ユーザー作成
  curl -s -X POST "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/users" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"user\",
      \"enabled\": true,
      \"firstName\": \"Demo\",
      \"lastName\": \"User\",
      \"email\": \"user@example.com\",
      \"emailVerified\": true,
      \"credentials\": [{
        \"type\": \"password\",
        \"value\": \"password\",
        \"temporary\": false
      }]
    }" > /dev/null

  echo "✅ ユーザー 'user' (パスワード: password) を作成しました"
fi
echo ""

# 結果を表示
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✨ Keycloak セットアップが完了しました！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 以下の情報を .env.local に設定してください："
echo ""
echo "AUTH_KEYCLOAK_ID=${CLIENT_ID}"
echo "AUTH_KEYCLOAK_SECRET=${CLIENT_SECRET}"
echo "AUTH_KEYCLOAK_ISSUER=${KEYCLOAK_URL}/realms/${REALM_NAME}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 次のステップ："
echo "1. cd ../../../frontend/control-plane"
echo "2. cp .env.example .env.local"
echo "3. .env.local を編集して上記の値を設定"
echo "4. AUTH_SECRET を生成: openssl rand -base64 32"
echo "5. bun run dev でアプリケーションを起動"
echo ""
