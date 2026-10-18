# syntax=docker/dockerfile:1
#
# Loopback scoring service for wp-exposed-backup. Holds the flag (derived from
# FLAG_SEED) and judges submissions. Bound to 127.0.0.1 only by the compose file.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
USER node

EXPOSE 8081

CMD ["node", "server.mjs"]
