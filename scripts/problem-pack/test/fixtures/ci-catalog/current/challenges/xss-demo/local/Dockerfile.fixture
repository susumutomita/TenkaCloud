# syntax=docker/dockerfile:1
#
# Deliberately vulnerable training target for TenkaCloud local play.
# The compose file binds it to 127.0.0.1 only — never expose it off loopback.
FROM node:22-alpine

WORKDIR /app
COPY app/ ./
USER node

EXPOSE 8080 8081

CMD ["node", "server.mjs"]
