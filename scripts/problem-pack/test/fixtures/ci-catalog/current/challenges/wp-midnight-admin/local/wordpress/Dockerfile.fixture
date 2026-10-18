# syntax=docker/dockerfile:1
#
# Real, current WordPress for TenkaCloud local play. This is NOT a vulnerable old
# build — it is the official current image. The teaching scenario is an incident
# response: an administrator account nobody added appeared overnight, and the
# player investigates WHO, HOW, and WHAT they left behind — all from outside, no
# login and no exploit. The wrapper entrypoint below plants the externally
# observable signals (a served access log and an abandoned plugin readme) before
# Apache starts. The compose file binds it to 127.0.0.1 only.
FROM wordpress:php8.3-apache

# The wrapper plants the file-based signals (access log, orphan plugin readme) and
# enables the standard WordPress rewrite so the REST API answers at /wp-json/...,
# then hands off to the stock WordPress entrypoint. Running it first guarantees the
# investigation surface exists the instant Apache serves.
COPY seed-and-start.sh /usr/local/bin/seed-and-start.sh
RUN chmod +x /usr/local/bin/seed-and-start.sh

ENTRYPOINT ["seed-and-start.sh"]
CMD ["apache2-foreground"]
