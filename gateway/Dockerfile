# Edge gateway — deployed on-site, near the scales. Talks outbound-only to
# the backend (cloud or on-prem), so this container needs no inbound ports
# open except the local health check (see docker-compose.yml).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# QUEUE_DIR (see queue.js / docker-compose.yml) points the durable reading
# buffer here, on the mounted volume, so a container recreate doesn't lose
# whatever was queued during a backend outage.
RUN mkdir -p /app/data

# Health check hits the gateway's own local endpoint (see gateway.js) —
# reports unhealthy if it can't reach any devices or its buffer is backing up,
# not just "process is alive".
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:9090/healthz | grep -q '"status": "ok"' || exit 1

# Runs as a non-root user — standard hardening for anything deployed on a
# plant network, where this container may sit alongside other on-site systems.
RUN addgroup -S gateway && adduser -S gateway -G gateway && chown -R gateway:gateway /app
USER gateway

CMD ["node", "gateway.js"]
