# syntax=docker/dockerfile:1
#
# Real, current WordPress for TenkaCloud local play. This is NOT a vulnerable old
# build — it is the official current image. The teaching scenario is operational
# neglect (a DB backup left in the public web root), added by the wrapper
# entrypoint below. The compose file binds it to 127.0.0.1 only.
FROM wordpress:php8.3-apache

# The wrapper writes the neglected backup file (and a robots.txt that "hides" it)
# into the docroot, then hands off to the stock WordPress entrypoint. Running it
# first guarantees the challenge surface exists the instant Apache serves.
COPY seed-and-start.sh /usr/local/bin/seed-and-start.sh
RUN chmod +x /usr/local/bin/seed-and-start.sh

ENTRYPOINT ["seed-and-start.sh"]
CMD ["apache2-foreground"]
