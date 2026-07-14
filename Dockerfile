# syntax=docker/dockerfile:1

# ---- builder: compile TypeScript to dist/ ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production dependencies + built output ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WIGOLO_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Browser engine for JS-rendered pages. Chromium only, with its OS libraries.
RUN npx playwright install --with-deps chromium

# Writable location for the local cache, models, and encrypted keys.
RUN mkdir -p /data && chown -R node:node /data /app /ms-playwright
VOLUME ["/data"]
USER node

# stdio MCP server by default. Override CMD for other subcommands (serve, doctor).
ENTRYPOINT ["node", "dist/index.js"]
CMD ["mcp"]
