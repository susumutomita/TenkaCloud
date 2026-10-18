# syntax=docker/dockerfile:1
#
# Real, current WordPress for TenkaCloud local play (remediation edition). This is NOT a
# vulnerable old build — it is the official current image. The compose file binds it to
# 127.0.0.1.
#
# ## Why this is two stages
#
# The participant gets a shell in THIS container (the Portal terminal, `runtime.terminal`
# in metadata.json), and the platform refuses to attach unless the service builds with
# `target: participant`. That target is the catalog's promise that the image holds no
# author-only material.
#
# It did until now. The previous layout copied `seed-and-start.sh` in as the entrypoint,
# and that script names all four leaks and their exact paths — while the problem asks the
# participant to work out where the leaks are by comparing the outside and inside views.
# Planting now happens from the one-shot `wpinit` service, which does not share its image
# with anybody, so this stage is stock WordPress plus two pieces of configuration that are
# part of the scenario and discoverable from inside anyway.
FROM wordpress:php8.3-apache AS participant

# Revalidate opcache every request so an edit to wp-config.php (e.g. the player turning
# WP_DEBUG off to close the debug-log checkpoint) takes effect immediately instead of
# after the default 2s window — otherwise a re-scan right after the fix confusingly still
# reports the hole open.
RUN printf 'opcache.revalidate_freq=0\n' > /usr/local/etc/php/conf.d/zz-revalidate.ini

# Directory listing for /internal only (scoped, not global). Written to conf-available and
# enabled here, so `a2disconf zz-internal-autoindex` remains a valid fix for the
# close-listing checkpoint, alongside adding an index.html or removing the folder.
#
# This is Apache configuration the participant can read from inside the container either
# way — it is the state they are asked to change, not a description of the answer. See
# TEMPLATE.md "Assurance scope" for what the stage boundary does and does not claim.
RUN cat > /etc/apache2/conf-available/zz-internal-autoindex.conf <<'CONF' \
 && a2enconf zz-internal-autoindex
<Directory /var/www/html/internal>
    Options +Indexes
    AllowOverride None
    Require all granted
</Directory>
CONF
