#!/bin/sh
#
# One-shot WP-CLI init for the "midnight admin" incident. Makes the site a working
# WordPress install (not the setup wizard) so the player investigates a real,
# running site, then plants the two WordPress-content signals:
#
#   rogue-admin   the admin account nobody added (media-sync, role administrator),
#                 whose bio (user description) carries the audit passphrase and who
#                 authors a published post so REST /wp/v2/users exposes it anonymously.
#   spam-post     the intruder's SEO-spam post, authored by media-sync, with the
#                 passphrase hidden in an HTML comment in the body.
#
# Idempotent — safe if the stack is restarted. The admin password is derived from
# FLAG_SEED (unknowable), so logging in as admin is NOT the intended path; the four
# externally observable signals are.
set -e

FLAG_SEED="${FLAG_SEED:-local-dev-seed}"
ADMIN_PW="admin-$(printf '%s' "admin:${FLAG_SEED}" | sha256sum | cut -c1-16)"

# Same derivation as seed-and-start.sh / the verify container:
# TC{<prefix>_<sha256("flag:<id>:<seed>")[:20]>}.
flag_for() {
  hash="$(printf '%s' "flag:${1}:${FLAG_SEED}" | sha256sum | cut -c1-20)"
  printf 'TC{%s_%s}' "${2}" "${hash}"
}
FLAG_ROGUE_ADMIN="$(flag_for rogue-admin wpadmin)"
FLAG_SPAM_POST="$(flag_for spam-post wpspam)"

# The DB is already up (compose depends_on: db service_healthy) and the WordPress
# core files are present (wordpress is service_healthy = Apache serving, which only
# happens after the stock entrypoint copies core into the shared volume). Poll
# version.php as a cheap belt-and-suspenders. We do NOT use `wp db check`: it shells
# out to the mysql client, which the wordpress:cli image doesn't bundle — every
# command here talks to the DB through PHP's mysqli instead.
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
  --title="さくらデザイン" \
  --admin_user="sakura-admin" \
  --admin_password="${ADMIN_PW}" \
  --admin_email="sakura-admin@sakura-design.example" \
  --skip-email

# Pretty permalinks so the REST API answers at /wp-json/wp/v2/... — the recon path.
# The Apache rewrite (seed-and-start.sh) routes /wp-json/ into index.php; setting a
# non-default structure and flushing registers WordPress's internal REST rewrite
# rules so /wp-json/wp/v2/users and /wp-json/wp/v2/posts resolve. Soft flush (no
# --hard) updates the DB option only, so no .htaccess write is needed.
wp rewrite structure '/%postname%/' --allow-root
wp rewrite flush --allow-root

wp option update blogdescription "Web と紙のデザイン事務所" --allow-root

# Seed a little legitimate content so the site is a working install.
wp post create --allow-root --post_status=publish \
  --post_title="ごあいさつ" \
  --post_content="さくらデザインのサイトへようこそ。制作のご相談はお問い合わせフォームからどうぞ。"

# A legit editor + published post, so the rogue account is NOT the only extra author
# and the user list looks realistic. Editors who author a published post also appear
# in the anonymous REST /wp/v2/users listing.
wp user create haruka haruka@sakura-design.example --role=editor --allow-root
HARUKA_ID="$(wp user get haruka --field=ID --allow-root)"
wp post create --allow-root --post_status=publish \
  --post_author="${HARUKA_ID}" \
  --post_title="夏季休業のお知らせ" \
  --post_content="8月13日から16日まで夏季休業をいただきます。ご不便をおかけしますが、よろしくお願いいたします。"

# --- checkpoint: rogue-admin --------------------------------------------------
# The administrator account nobody added. The name "media-sync" is plausible but
# unfamiliar — the "nobody added it" tell. Its bio (description) is what REST
# /wp/v2/users exposes to anonymous callers, so that is where the passphrase lives.
wp user create media-sync media-sync@mail.example --role=administrator --allow-root
MEDIA_SYNC_ID="$(wp user get media-sync --field=ID --allow-root)"
wp user meta update media-sync description \
  "自動メディア同期サービス用アカウント。 audit passphrase: ${FLAG_ROGUE_ADMIN}" --allow-root
# Give media-sync an authored published post so the anonymous REST user listing
# (which only exposes authors of published posts of a public post type) returns it.
wp post create --allow-root --post_status=publish \
  --post_author="${MEDIA_SYNC_ID}" \
  --post_title="お知らせ" \
  --post_content="サイトの一部を更新しました。今後ともよろしくお願いいたします。"

# --- checkpoint: spam-post ----------------------------------------------------
# The intruder's SEO-spam post, authored by the rogue admin. The passphrase is
# hidden in an HTML comment in the body, visible in the raw page source and in the
# REST content.rendered. --user=1 runs as the site admin (who has unfiltered_html on
# single-site) so the HTML comment survives instead of being stripped by KSES.
wp post create --allow-root --user=1 --post_status=publish \
  --post_author="${MEDIA_SYNC_ID}" \
  --post_title="＼激安／ ブランド品 最大80%OFF 期間限定セール" \
  --post_content="<p>大人気ブランド品を最大80%OFFの特別価格でご提供中！ 数量限定・期間限定の今だけ大セール。 今すぐ下記リンクからお申し込みください。</p><p>お得なクーポンコードも配布中です。 お見逃しなく！</p><!-- audit passphrase: ${FLAG_SPAM_POST} -->"

echo "wpinit: done."
