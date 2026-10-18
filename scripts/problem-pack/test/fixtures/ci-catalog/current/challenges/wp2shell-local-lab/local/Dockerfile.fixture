# syntax=docker/dockerfile:1
#
# wp2shell-local-lab -- a from-scratch simulator (NOT WordPress, no WordPress code
# vendored or adapted). Only Node.js core modules are used (node:http, node:crypto,
# node:sqlite): no child_process, no exec/eval anywhere in server.mjs, and no
# outbound fetch target other than the app's own loopback port. See
# scripts/wp2shell-local-lab.test.ts, which fails CI if either guarantee regresses.
# The compose file binds this service to 127.0.0.1 only and attaches it to an
# `internal: true` network -- never expose it off loopback, and it could not reach
# the public internet even if it tried.
FROM node:22-alpine

WORKDIR /app
COPY app/ ./
USER node

EXPOSE 8080 8081

# node:sqlite is behind --experimental-sqlite on Node 22.
CMD ["node", "--experimental-sqlite", "server.mjs"]
