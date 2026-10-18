#!/bin/bash
#
# Plant the externally observable signals for the "midnight admin" incident, then
# start WordPress normally. This is a multi-checkpoint investigation problem
# (TenkaCloud#2252): an administrator account nobody added appeared overnight, and
# the player reconstructs the incident from four independent, real WordPress
# operational signals — no login and no exploit, every signal is visible from
# outside:
#
#   rogue-admin     an unexpected admin exposed via REST user enumeration   (/wp-json/wp/v2/users)  [planted by wpinit]
#   login-trail     a served access log: the brute-force burst + one success (/server-logs/access.log)
#   orphan-plugin   an abandoned plugin's world-readable readme              (/wp-content/plugins/legacy-contact-form/readme.txt)
#   spam-post       the intruder's SEO-spam post in the content feed         (/wp-json/wp/v2/posts) [planted by wpinit]
#
# This script plants the two FILE signals (access log, orphan plugin readme). The
# two WordPress-content signals (the rogue admin's bio and the spam post) are
# planted by wpinit/init.sh once WordPress is installed. Each signal carries its own
# audit passphrase (the flag), derived from the per-deploy random FLAG_SEED so
# nothing secret is committed and every deploy is unique. The verify container
# derives the same values to judge each checkpoint. The compose file binds
# everything to 127.0.0.1 only.
set -e

FLAG_SEED="${FLAG_SEED:-local-dev-seed}"

# Same derivation the verify container and wpinit use:
# TC{<prefix>_<sha256("flag:<id>:<seed>")[:20]>}. The checkpoint id is mixed in so
# each signal has a distinct, unpredictable flag.
flag_for() {
  hash="$(printf '%s' "flag:${1}:${FLAG_SEED}" | sha256sum | cut -c1-20)"
  printf 'TC{%s_%s}' "${2}" "${hash}"
}
FLAG_LOGIN_TRAIL="$(flag_for login-trail wplogin)"
FLAG_ORPHAN_PLUGIN="$(flag_for orphan-plugin wpplugin)"

DOCROOT="/var/www/html"
mkdir -p "${DOCROOT}/server-logs" "${DOCROOT}/wp-content/plugins/legacy-contact-form"

# Enable the standard WordPress rewrite so the REST API answers at /wp-json/... —
# the recon path the investigation uses. The stock image serves the plain URL
# fallback /?rest_route=/... out of the box, but the pretty /wp-json/ path (and the
# healthcheck below) needs everything that is not a real file/dir routed into
# index.php. Real files (the access log, the plugin readme, /wp-admin, /wp-login.php)
# still serve directly because of the !-f / !-d conditions. wpinit then sets the
# permalink structure so WordPress registers its internal /wp-json/ → rest_route
# rules on top of this Apache-level routing.
cat > /etc/apache2/conf-available/zz-wp-rewrite.conf <<'CONF'
<Directory /var/www/html>
    Options FollowSymLinks
    AllowOverride All
    Require all granted
    RewriteEngine On
    RewriteBase /
    RewriteRule ^index\.php$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . /index.php [L]
</Directory>
CONF
a2enmod rewrite >/dev/null 2>&1 || true
a2enconf zz-wp-rewrite >/dev/null

# --- checkpoint: login-trail --------------------------------------------------
# A served access log the ops team kept in the public web root. It captured a
# brute-force burst of failed logins from one unfamiliar IP (203.0.113.66, a
# documentation range), a little normal traffic from other visitors, then the one
# clearly-different success (302 to /wp-admin/). The literal burst has no expansions
# (single-quoted heredoc); only the tripwire annotation carries the flag.
cat > "${DOCROOT}/server-logs/access.log" <<'LOG'
198.51.100.23 - - [08/Jul/2026:02:11:04 +0000] "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
203.0.113.66 - - [08/Jul/2026:02:12:31 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "http://127.0.0.1/wp-login.php" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:33 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:35 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:38 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
198.51.100.61 - - [08/Jul/2026:02:12:40 +0000] "GET /?p=12 HTTP/1.1" 200 6210 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)"
203.0.113.66 - - [08/Jul/2026:02:12:41 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:44 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:47 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:50 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
192.0.2.15 - - [08/Jul/2026:02:12:52 +0000] "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
203.0.113.66 - - [08/Jul/2026:02:12:54 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:12:57 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:13:01 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:13:05 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:13:09 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
198.51.100.23 - - [08/Jul/2026:02:13:12 +0000] "GET /?p=7 HTTP/1.1" 200 5980 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
203.0.113.66 - - [08/Jul/2026:02:13:14 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:13:18 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:13:22 +0000] "POST /wp-login.php HTTP/1.1" 200 1734 "-" "python-requests/2.31.0"
LOG
# The one success (302 → /wp-admin/), the follow-up admin page load, and the ops
# tripwire annotation. Unquoted heredoc so ${FLAG_LOGIN_TRAIL} expands; no backticks
# so nothing is command-substituted.
cat >> "${DOCROOT}/server-logs/access.log" <<LOG
203.0.113.66 - - [08/Jul/2026:02:14:12 +0000] "POST /wp-login.php HTTP/1.1" 302 0 "http://127.0.0.1/wp-login.php" "python-requests/2.31.0"
203.0.113.66 - - [08/Jul/2026:02:14:13 +0000] "GET /wp-admin/ HTTP/1.1" 200 9021 "http://127.0.0.1/wp-login.php" "python-requests/2.31.0"
# [tripwire] admin login SUCCEEDED from 203.0.113.66 after 217 failures — audit token: ${FLAG_LOGIN_TRAIL}
LOG

# --- checkpoint: orphan-plugin ------------------------------------------------
# An abandoned plugin left installed. Its readme.txt is world-readable by design (a
# real recon/inventory signal) and its header shows an ancient Stable tag / Tested
# up to. No active PHP is added — the presence + readable readme is the finding. The
# literal header has no expansions; only the ops NOTE carries the flag.
cat > "${DOCROOT}/wp-content/plugins/legacy-contact-form/readme.txt" <<'README'
=== Legacy Contact Form ===
Contributors: oldvendor
Tags: contact, form
Requires at least: 3.5
Tested up to: 4.9
Stable tag: 2.1.3
License: GPLv2

A simple contact form. (This plugin has not been updated in years.)

== Notes ==
README
cat >> "${DOCROOT}/wp-content/plugins/legacy-contact-form/readme.txt" <<README
ops audit token (do not ship to production): ${FLAG_ORPHAN_PLUGIN}
README

# Make the two file signals world-readable the way a misconfigured host would leave
# them (a direct GET of the known path is the intended find; directory listing is
# NOT enabled — that is a different problem's lesson).
chmod -R a+rX "${DOCROOT}/server-logs" "${DOCROOT}/wp-content/plugins/legacy-contact-form"
chmod a+r "${DOCROOT}/server-logs/access.log" \
  "${DOCROOT}/wp-content/plugins/legacy-contact-form/readme.txt"

# Hand off to the stock WordPress entrypoint (copies core, writes wp-config, then
# runs the passed command, e.g. apache2-foreground).
exec docker-entrypoint.sh "$@"
