FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libxss1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/
COPY services/worker/package.json ./services/worker/
COPY services/dispatcher/package.json ./services/dispatcher/
COPY tools/mock-backend/package.json ./tools/mock-backend/
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared ./packages/shared
COPY services/worker ./services/worker
RUN npm run build --workspace=@wa/shared
RUN npm run build --workspace=@wa/worker

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libxss1 \
      libasound2 \
      tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/worker/dist ./services/worker/dist
COPY --from=build /app/services/worker/package.json ./services/worker/package.json
COPY --from=build /app/package.json ./package.json
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "services/worker/dist/main.js"]
