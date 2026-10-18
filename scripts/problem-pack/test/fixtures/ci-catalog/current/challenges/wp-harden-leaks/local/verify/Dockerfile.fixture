# syntax=docker/dockerfile:1
#
# The "external scanner" / loopback scoring service for wp-harden-leaks. It holds NO
# secret — for each checkpoint it HTTP-probes the live WordPress container over the
# compose network and judges the hole CLOSED by the response. Bound to 127.0.0.1 only
# by the compose file.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
USER node

EXPOSE 8081

CMD ["node", "server.mjs"]
