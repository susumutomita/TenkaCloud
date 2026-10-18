#!/bin/sh
#
# One-shot WP-CLI init: make the site a working WordPress install (not the setup
# wizard) so the participant audits a real, running site. Idempotent — safe if the
# stack is restarted. The admin password is derived from FLAG_SEED (unknowable), so
# logging in as admin is NOT the intended path; the neglected backup file is.
set -e

FLAG_SEED="${FLAG_SEED:-local-dev-seed}"
ADMIN_PW="admin-$(printf '%s' "admin:${FLAG_SEED}" | sha256sum | cut -c1-16)"

# The DB is already up (compose depends_on: db service_healthy) and the WordPress
# core files are present (wordpress is service_healthy = Apache serving, which only
# happens after the stock entrypoint copies core into the shared volume). We still
# poll for version.php as a cheap belt-and-suspenders. We do NOT use `wp db check`:
# it shells out to the mysql client, which the wordpress:cli image doesn't bundle —
# every other command here talks to the DB through PHP's mysqli instead.
echo "wpinit: waiting for WordPress core files..."
until [ -f /var/www/html/wp-includes/version.php ]; do sleep 3; done

if wp core is-installed --allow-root >/dev/null 2>&1; then
  echo "wpinit: already installed; nothing to do."
  exit 0
fi

# ポートを焼き込まない (Issue 399)。実際の配信 URL は wp-config.php の WP_HOME /
# WP_SITEURL が Host から毎回決めるので、ここは install を通すための値でよい。
wp core install --allow-root \
  --url="http://localhost" \
  --title="Aoi Corp" \
  --admin_user="admin" \
  --admin_password="${ADMIN_PW}" \
  --admin_email="admin@aoi-corp.example" \
  --skip-email

wp option update blogdescription "デザインと印刷のご相談承ります" --allow-root
wp post create --allow-root --post_status=publish \
  --post_title="ごあいさつ" \
  --post_content="Aoi Corp のコーポレートサイトへようこそ。お問い合わせはフォームからどうぞ。"
wp post create --allow-root --post_status=publish \
  --post_title="サイトをリニューアルしました" \
  --post_content="このたびサイトを移行しました。今後ともよろしくお願いいたします。"

echo "wpinit: done."
