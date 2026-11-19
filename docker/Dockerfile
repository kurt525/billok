FROM public.ecr.aws/docker/library/node:22-alpine AS base
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000

# --- Builder ---
FROM base AS builder
WORKDIR /app
ENV DOCKER_BUILD=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npx prisma generate
RUN npm run build
ARG COMMIT_SHA=unknown
RUN echo "$COMMIT_SHA" > .commit-sha

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Only the application is in this image: PostgreSQL exists separately.
# hadolint ignore=DL3018
RUN apk add --no-cache su-exec

# Create users
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.commit-sha ./.commit-sha
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/src/generated ./src/generated
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY docker/load-secrets.sh /app/load-secrets.sh

# Create directories
RUN mkdir -p /app/uploads/receipts && \
    chown -R nextjs:nodejs /app/uploads && \
    chmod +x /app/entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

VOLUME ["/app/uploads"]

# Application has no PostgreSQL init or automatic DDL on startup.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
